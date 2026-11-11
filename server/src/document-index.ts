/******************************************************************************
 * 构建阶段 2：文档级索引 + 全局符号表
 *
 * GlobalIndex 是全局符号表，按 name 和 module 索引所有符号定义。
 * 索引阶段直接将 TypeInfo/FuncInfo/InstDef/ModeDef 写入 GlobalIndex。
 *   a. pred/func/type/inst/mode/ctor 定义与声明（含结构化签名）
 *   b. import_module / use_module / include_module
 *   c. interface 段（:- interface. 到 :- implementation. 之间）声明的导出标记
 * 全部文档 index 完成后，阶段 3 才有足够信息做 clause body 的类型推导与名称解析。
 ******************************************************************************/
import { CancellationToken, Diagnostic, DiagnosticSeverity } from 'vscode-languageserver'
import { DocumentState, type MercuryDocument } from './document-manager'
import type { Term, Clause } from './term'
import { MultiMap } from './multimap'
import { stream } from './stream'
import { interruptAndCheck } from './promise-util'
import { moduleQualifiedName, equalQualified } from './utils'
import {
    MerType, keyOf, modeOfArg,
    varType, typeType, constructorType,
} from './document-type'
import {
    instTermToMerInst, instFunctorAlts, modeTermToRef, instDefHead,
    type MerInst, type MerModeRef,
} from './document-mode'

// 两个纯函数放在叶子模块 utils，避免 document-index ↔ document-typeinfer 的运行时环；
// 这里 re-export 保持既有导入路径不变
export { moduleQualifiedName, equalQualified } from './utils'

export type ImportKind = 'import_module' | 'use_module' | 'include_module'

/** 一条模块依赖，记录来源类别与所在 section（interface 段的 import 可传递可见） */
export interface ModuleImport {
    kind: ImportKind
    /** 点分模块名，如 `std.array` */
    module: string
    term: Term
    section?: string
}

/** 全局符号表里的一条符号 */
export interface SymbolEntry {
    name: string
    arity: number
    /** VisitResult 的 semanticType（func/pred/type/constructor/inst/mode/...） */
    kind: string
    term: Term
    doc: MercuryDocument
    module?: string
    /** 该符号声明在 interface 段（含其实现侧定义），可被其他模块引用 */
    exported: boolean
    /** 类型签名（与 typeinfer 阶段保持一致） */
    signature?: MerType
}

export class GlobalIndex {
    /** 按 name 索引的符号 */
    byName = new MultiMap<string, SymbolEntry>()
    /** 按 module 索引的符号 */
    byModule = new MultiMap<string, SymbolEntry>()
    /** 每个文档最近一次索引产出的符号，供重新索引/删除时注销 */
    private symbolsByDoc = new Map<MercuryDocument, SymbolEntry[]>()
    /** 当前文档遍历期间收集的符号，build 完成后由 update 统一注册 */
    private currentSymbols: SymbolEntry[] = []

    /** 按 name 获取符号 */
    getByName(name: string) {
        return this.byName.get(name)
    }

    /** 按 module 获取符号 */
    getByModule(module: string) {
        return this.byModule.get(module)
    }

    /** 按 name 和 module 获取符号 */
    get(name: string, module?: string) {
        const byName = this.byName.get(name)
        if (!module) return byName
        return byName.filter(s => s.module === module)
    }

    /** 获取导出的符号 */
    getExported(name: string) {
        return this.byName.get(name).filter(s => s.exported)
    }

    /** 注册文档的所有符号 */
    registerSymbols(symbols: SymbolEntry[]): void {
        for (const s of symbols) {
            this.byName.add(s.name, s)
            if (s.module) this.byModule.add(s.module, s)
        }
    }

    /** 注销文档的所有符号 */
    unregisterSymbols(symbols: SymbolEntry[]): void {
        for (const s of symbols) {
            this.byName.delete(s.name, s)
            if (s.module) this.byModule.delete(s.module, s)
        }
    }














    /** 索引文档：重新遍历前先注销该文档上一次登记的全部符号 */
    async update(doc: MercuryDocument, cancelToken: CancellationToken, options?: { infer?: boolean }): Promise<void> {
        const previous = this.symbolsByDoc.get(doc)
        if (previous) this.unregisterSymbols(previous)
        this.symbolsByDoc.delete(doc)
        this.resetVisitState()
        await this.build(doc, cancelToken)
        this.registerSymbols(this.currentSymbols)
        this.symbolsByDoc.set(doc, this.currentSymbols)
        doc.state = DocumentState.Indexed
    }

    /** 删除文档：注销其全部符号 */
    delete(doc: MercuryDocument): void {
        const symbols = this.symbolsByDoc.get(doc)
        if (!symbols) return
        this.unregisterSymbols(symbols)
        this.symbolsByDoc.delete(doc)
    }
    private resetVisitState(): void {
        this.module = undefined
        this.currentModule = ''
        this.imports = []
        this.moduleImports = []
        this.section = undefined
        this.errors = []
        this.currentSymbols = []
        this.currentTypeSignature = undefined

    }

    module?: Term
    currentModule = ''
    imports = [] as Term[]
    moduleImports = [] as ModuleImport[]
    section?: string
    currentClause!: Clause
    errors: Diagnostic[] = []

    private currentDoc?: MercuryDocument
    /** 当前类型定义的签名，构造子签名的结果类型用它 */
    private currentTypeSignature?: MerType
    /** 登记一条命名符号（定义/声明/模块项），exported 由声明所在 section 决定 */
    private addSymbol(term: Term, kind: string, signature?: MerType): void {
        if (!term || isVariable(term) || !this.currentDoc) return
        if (this.currentSymbols.some(s => s.term === term)) return
        this.currentSymbols.push({
            name: term.name,
            arity: term.semanticArity ?? term.arity,
            kind,
            term,
            doc: this.currentDoc,
            module: this.currentModule || undefined,
            exported: this.section === 'interface' && kind !== 'module',
            signature,
        })
    }
    /** 遍历一个文档的 AST，直接写入 GlobalIndex */
    private async build(doc: MercuryDocument, cancelToken: CancellationToken) {
        this.currentDoc = doc
        let rootNode = doc.parseResult.value
        for (const clause of rootNode.args) {
            await interruptAndCheck(cancelToken)
            this.visitClause(clause)
        }
    }
    visitClause(clause: Clause) {
        this.currentClause = clause
        let topTerm = clause.term
        switch (topTerm.nameArity) {
            case ":-/1":
                // declaration : ':-'(Decl)
                this.visitDecl(topTerm.args[0])
                break
            // rule : ':-'(RuleHead,RuleBody)
            case ":-/2":
                this.visitRuleHead(topTerm.args[0])
                this.visitRuleBody(topTerm.args[1])
                break
            case "=/2":
                // func_fact ：'='(Func,FuncReturn)
                this.visitFuncRuleHead(topTerm)
                break
            case "-->/2":
                // dcg : '-->'(DcgHead,DcgBody)
                this.visitDcgHead(topTerm.args[0])
                this.visitDcgBody(topTerm.args[1])
                break
            default:
                //  pred_fact : PredFact
                this.visitPredDef(topTerm)
                break
        }
    }

    visitDcgHead(term: Term) {
        this.DcgFixArity(term)
        this.visitPredDef(term)
    }
    visitDcgBody(term: Term) {
        switch (term.nameArity) {
            case "some/2":
            case "all/2": {
                this.visitDcgBody(term.args[1])
                break
            }
            case ",/2":
            // case "&/2":
            case ";/2":
                {
                    this.visitDcgBody(term.args[0])
                    this.visitDcgBody(term.args[1])
                    break
                }
            case '{}/1': {
                this.visitRuleBody(term.args[0])
                break
            }
            // case "[|]/2":
            // case "[]/0":
            // case "true":
            // case "fail":
            case "not/1":
            case "\\+/1":
                {
                    this.visitDcgBody(term.args[0])
                    break
                }
            case "impure/1":
            case "semipure/1":
            case "pure/1":
                // goal 级 purity 前缀是关键字：跳过词头，递归目标本体
                {
                    this.visitDcgBody(term.args[0])
                    break
                }
            // case "=>/2":
            // case "<=/2":
            // case "<=>/2":
            case "else/2": {
                this.visitDcgBody(term.args[0])
                this.visitDcgBody(term.args[1])
                break
            }

            case "if/1": {
                this.visitDcgBody(term.args[0])
                break
            }
            case "then/2":
            case "->/2":
                // case "=/2":
                // case "\\=/2":
                {
                    this.visitDcgBody(term.args[0])
                    this.visitDcgBody(term.args[1])
                    break
                }
            case "=/1":
            case ":=/1": {
                this.visitDataTerm(term.args[0])
                break
            }
            case "=^/2": {
                this.visitDataTerm(term.args[0]);
                this.visitFieldList(term.args[1], 'select');
                break;
            }
            case ":=/2": {
                if (nameArity(term.args[0], "^/1")) {
                    this.visitFieldList(term.args[0].args[0], 'update')
                } else {
                    this.visitDataTerm(term.args[0])
                }
                this.visitDataTerm(term.args[1])
                break
            }
            case "^/1": {
                this.visitRuleBody(term.args[0])
                break

            }
            default:
                this.DcgFixArity(term);
                this.visitPredRef(term)
        }
    }
    visitDataTerm(term: Term) {
        if (isVariable(term)) {
            this.visitVariable(term);
        } else if (isSpecialDataTerm(term)) {
            this.visitSpecialDataTerm(term)
        } else {
            this.visitDataFunctor(term);
        }
    }
    visitDataFunctor(term: Term) {
        switch (term.syntaxType) {
            case 'integer':
                this.visitInteger(term)
                break;
            case 'float':
                this.visitFloat(term)
            case 'string':
                this.visitString(term)
                break;
            case 'atom':
                this.visitFuncOrPredOrConstr(term)
                break;
            case 'implementation_defined':
                this.visitImplementationDefined(term)

        }
    }
    visitImplementationDefined(term: Term) {
        // `$name` 形式的 implementation-defined 项：不进 reference，仅标注避免抛错
        label(term, "implementationDefined")
    }
    visitFuncOrPredOrConstr(term: Term) {
        // 项层类型限定 `Term :: Type`：Type 是类型引用位置
        if (nameArity(term, "::/2")) {
            this.visitDataTerm(term.args[0])
            this.visitTypeRef(term.args[1])
            return
        }
        // lambda 体里的目标 `X = 1`、`X \= Y` 与高阶模式头 `pred(...) is Det`：
        // `=`/`\=`/`is` 是关键字，在数据位置不作引用
        if (nameArity(term, "=/2") || nameArity(term, "\\=/2")) return
        if (nameArity(term, "is/2") && ["pred", "predicate", "func", "function"].includes(term.args[0]?.name)) return
        // 高阶闭包 `p/2`（Name/Arity）：pred/func 引用，语义元数取 Arity
        if (this.visitNameArityRef(term)) return
        let rightTerm = this.visitQualifiedTerm(term)

        // 参数位置的项也是引用（嵌套构造子/函数调用，如 sva(uva.init(N, X))），
        // 同样索引进 reference 参与 link（变量除外）
        for (const arg of rightTerm.args ?? []) {
            if (!isVariable(arg)) this.visitDataTerm(arg)
        }
    }
    // `Name/Arity` 形式（解析为 //2(Atom, IntAtom)）的 pred/func 引用：
    // 标 pred、记语义元数、进 reference；非该形式返回 false
    visitNameArityRef(term: Term): boolean {
        if (!nameArity(term, "//2") || term.args.length !== 2) return false
        const [nameTerm, arityTerm] = term.args
        const n = Number.parseInt(arityTerm?.name ?? '', 10)
        if (Number.isNaN(n) || isVariable(nameTerm)) return false
        label(nameTerm, "pred")
        nameTerm.semanticArity = n

        return true
    }
    visitFloat(term: Term) {
        label(term, "float")
    }
    visitInteger(term: Term) {
        label(term, "integer")
    }
    visitSpecialDataTerm(term: Term) {
        switch (term.semanticType as SpecialDataTerm) {
            case 'conditional':
                // 项层条件表达式： ;/2 、 ->/2 、 else/2 、 if/3
                this.visitDataTerm(term.args[0])
                if (term.args.length > 1) this.visitDataTerm(term.args[1])
                break
            case 'record':
                // 记录语法（Mercury: record syntax）：`Term ^ field_list`、
                // `Term ^ field_list := Value`、DCG 的 `=^` / `^ field_list := Value`。
                // 字段说明符不是普通 functor，它引用的是 field access function。
                this.visitRecordSyntax(term)
                break
            case 'unification':
                // 项注解： @/2 (Term @ Ann)
                this.visitDataTerm(term.args[0])
                this.visitDataTerm(term.args[1])
                break
            case 'apply':
                // 高阶应用： apply(F) 或 apply(F, Args)
                this.visitDataTerm(term.args[0])
                if (term.args.length > 1) this.visitDataTerm(term.args[1])
                break
            case 'explicitType':
                // 显式类型限定： :/2 (Term : Type) 或 with_type/2，第二参是类型引用位置
                this.visitDataTerm(term.args[0])
                this.visitTypeRef(term.args[1])
                break
            case 'lambda':
                // 闭包： :-/2 或 --/2 (lambda 头, 体)
                this.visitDataTerm(term.args[0])
                if (term.args.length > 1) this.visitDataTerm(term.args[1])
                break
        }
    }
    // 记录语法（Mercury reference manual §2.15.2 Record syntax）：
    // `Term ^ field_list` 是 field selection，`Term ^ field_list := V` 是 field update。
    // field specifier `field/N` 要求可见的 field selection function `field/(N+1)`，
    // 更新式还要求 field update function `'field :='/(N+2)`。这里按该规则把
    // 字段说明符索引成函数引用，并记录派生名字/元数供定义与引用互查。
    private visitRecordSyntax(term: Term, role: 'select' | 'update' = 'select') {
        switch (term.nameArity) {
            case '^/2':
                // args[0] 是数据项，args[1] 是字段列表（链式的 ^/2 也走这里）
                if (term.args[0]?.nameArity === '^/2') this.visitRecordSyntax(term.args[0], role)
                else this.visitDataTerm(term.args[0])
                this.visitFieldList(term.args[1], role)
                return
            case ':=/2':
                // `Term ^ field_list := V` / DCG `^ field_list := V`
                this.visitRecordSyntax(term.args[0], 'update')
                this.visitDataTerm(term.args[1])
                return
            case '=^/2':
                this.visitDataTerm(term.args[0])
                this.visitFieldList(term.args[1], role)
                return
            case '^/1':
                // DCG 的 `^ field_list`
                this.visitFieldList(term.args[0], 'update')
                return
            default:
                this.visitDataTerm(term.args[0])
                if (term.args.length > 1) this.visitDataTerm(term.args[1])
        }
    }
    // 字段列表：`field` 或 `field1 ^ field2`；逐个字段说明符建索引
    private visitFieldList(term: Term, role: 'select' | 'update' = 'select') {
        if (!term) return
        if (term.nameArity === '^/2' || term.nameArity === '^/1') {
            for (const arg of term.args) this.visitFieldList(arg, role)
            return
        }
        this.visitFieldSpecifier(term, role)
    }
    private visitFieldSpecifier(term: Term, role: 'select' | 'update') {
        if (isVariable(term)) {
            this.visitVariable(term)
            return
        }
        const head = this.visitQualifiedTerm(term)
        const n = head.arity
        // 语义实体是 field access function（不是构造子字段标签 fieldname）
        label(head, 'func')
        head.semanticArity = n + 1
        head.fieldAccess = {
            base: head.name,
            specArity: n,
            role,
            selectionName: head.name,
            selectionArity: n + 1,
            updateName: head.name + ' :=',
            updateArity: n + 2,
        }
        for (const arg of head.args ?? []) {
            if (!isVariable(arg)) this.visitDataTerm(arg)
        }
    }
    visitExpliciType(term: Term) {
        this.visitDataFunctor(term.args[0])
        this.visitTypeName(term.args[1])
    }
    visitUnification(term: Term) {
        // 
    }
    visitLambda(term: Term) {
        label(term, "lambda")
    }
    visitApply(term: Term) {
        label(term, "apply");

    }
    visitRecord(term: Term) {
        if (nameArity(term, "^/2")) {
            this.visitDataTerm(term.args[0])
            this.visitFieldList(term.args[1])
        } else {
            this.visitDataTerm(term)
        }
    }
    visitString(term: Term) {
        label(term, "string")
    }

    DcgFixArity(term: Term) {
        // DCG 头/调用的语义元数 = 语法元数 + 2（隐式的输入/输出列表参数）；
        // 不再直接改语法 arity，显示与定义/引用匹配走 semanticArity
        term.semanticArity = term.arity + 2
    }
    visitRuleHead(term: Term) {
        if (nameArity(term, '=/2')) {
            this.visitFuncRuleHead(term)
        } else {
            this.visitPredDef(term)
        }
    }
    visitPredDef(term: Term) {
        label(term, "pred")
        this.addSymbol(term, 'pred')
        this.currentClause.callee = term
    }
    visitRuleBody(term: Term) {
        switch (term.nameArity) {
            case "some/2":
            case "all/2": {
                this.visitRuleBody(term.args[1])
                break
            }
            case ",/2":
            case "&/2":
            case ";/2":
                {
                    this.visitRuleBody(term.args[0])
                    this.visitRuleBody(term.args[1])
                    break
                }

            case "true":
            case "fail":
                {
                    break
                }
            case "not/1":
            case "\\+/1":
                {
                    this.visitRuleBody(term.args[0])
                    break
                }
            case "impure/1":
            case "semipure/1":
            case "pure/1":
                // goal 级 purity 前缀是关键字：跳过词头，递归目标本体
                {
                    this.visitRuleBody(term.args[0])
                    break
                }
            case "=>/2":
            case "<=/2":
            case "<=>/2":
            case "else/2": {
                this.visitRuleBody(term.args[0])
                this.visitRuleBody(term.args[1])
                break
            }

            case "if/1": {
                this.visitRuleBody(term.args[0])
                break
            }
            case "then/2": {
                this.visitRuleBody(term.args[0])
                this.visitRuleBody(term.args[1])
                break
            }
            case "->/2":
                this.visitRuleBody(term.args[0])
                this.visitRuleBody(term.args[1])
                break
            case "=/2":
            case "\\=/2": {
                this.visitDataTerm(term.args[0])
                this.visitDataTerm(term.args[1])
                break
            }
            /** 
             * TODO:
             * call/N
             * Var/N
             */
            case "promise_pure/1":
            case "promise_semipure/1":
            case "promise_impure/1": {
                this.visitRuleBody(term.args[0])
                break
            }
            case "promise_equivalent_solutions/2":
            case "promise_equivalent_solution_sets/2": {
                this.visitRuleBody(term.args[1])
                break
            }


            case "require_det/1":
            case "require_semidet/1":
            case "require_multi/1":
            case "require_nondet/1":
            case "require_cc_multi/1":
            case "require_cc_nondet/1":
            case "require_erroneous/1":
            case "require_failure/1": {
                this.visitRuleBody(term.args[0])
                break
            }

            case "require_complete_switch/2":

            case "require_switch_arms_det/2":
            case "require_switch_arms_semidet/2":
            case "require_switch_arms_multi/2":
            case "require_switch_arms_nondet/2":
            case "require_switch_arms_cc_multi/2":
            case "require_switch_arms_cc_nondet/2":
            case "require_switch_arms_erroneous/2":
            case "require_switch_arms_failure/2":

            case "disable_warnings/2":
            case "disable_warning/2":
            case "trace/2": {
                this.visitRuleBody(term.args[1])
                break
            }

            case "catch_any/2":
            case "catch/2":
            case "try/2": {
                this.visitRuleBody(term.args[0])
                this.visitRuleBody(term.args[1])
                break
            }
            case "event/1": {
                this.visitRuleBody(term.args[0])
                break
            }
            default: {
                let rightTerm = this.visitQualifiedTerm(term)
                this.visitPredRef(rightTerm)


            }
        }
    }
    visitPredRef(term: Term) {
        label(term, "pred")

        // 目标参数位置的项也可能是 func 调用/构造子/闭包（如 map(p/2, Xs)、f(g(X))），
        // 同样索引进 reference 参与 link（变量除外）
        for (const arg of term.args ?? []) {
            if (!isVariable(arg)) this.visitDataTerm(arg)
        }
    }
    visitVarOrFuncOrDataOrPred(term: Term) {
        if (term.syntaxType == "variable") {
            this.visitVariable(term)
        } else if (["!/1", "!./1", "!:/1"].includes(term.nameArity)
            && term.args[0].syntaxType == "variable"
        ) {
            this.visitVariable(term.args[0])
        } else {
            this.visitFuncOrDataOrPred(term)
        }
    }
    visitFuncOrDataOrPred(term: Term) {
        this.currentClause.called.push(term)
        term.clause = this.currentClause;
    }
    visitVariable(term: Term) {
        term.clause = this.currentClause
        this.currentClause.varMap.add(term.name, term)
    }


    visitFuncRuleHead(term: Term) {
        let [func, funcResult] = term.args
        this.visitFuncDef(func)
        // 定义子句 `F(...) = 表达式` 的右侧是函数体/结果表达式，不是返回类型；
        // 按数据项访问（functor 或数据构造子由 linker 阶段区分），避免误标成 type
        this.visitDataTerm(funcResult)
        this.currentClause.callee = func
    }
    visitFuncDef(func: Term) {
        const head = this.visitQualifiedTerm(func)
        label(head, "func")
        this.addSymbol(head, 'func')

    }
    visitFuncReturn(funcReturn: Term) {
        // 函数返回值 `= (Type :: Mode)` 与声明参数同构：左侧是类型引用，右侧是 mode 引用。
        // 不能按构造子字段 `FieldName :: Type` 处理（visitTypeRef 的 ::/2 分支）
        this.visitTypeParam(funcReturn)
    }
    visitTypeRef(term: Term) {
        if (nameArity(term, "::/2")) {
            // `FieldName :: Type` 形式（构造子参数）：左侧是 fieldname，右侧是类型
            // ::/2 本身是运算符，不标记为 type
            if (!isVariable(term.args[0])) {
                label(term.args[0], "fieldname")

            }
            if (!isVariable(term.args[1])) this.visitTypeRef(term.args[1])
            return
        }
        // 高阶类型 `func(A1, ...) = R`（别名 `function(...)`）：`=` 与词头是关键字不是类型引用，
        // 参数类型与返回类型才是（递归，变量除外）
        if (nameArity(term, "=/2") && ["func", "function"].includes(term.args[0]?.name)) {
            for (const a of term.args[0].args ?? []) {
                if (!isVariable(a)) this.visitTypeRef(a)
            }
            if (!isVariable(term.args[1])) this.visitTypeRef(term.args[1])
            return
        }
        // 高阶类型 `pred(A1, ...)`（别名 `predicate(...)`）：同上
        if (["func", "function", "pred", "predicate"].includes(term.name)) {
            for (const a of term.args ?? []) {
                if (!isVariable(a)) this.visitTypeRef(a)
            }
            return
        }
        // 只有在不是特殊运算符的情况下才标记为 type
        label(term, "type")
        const right = this.visitQualifiedTerm(term)
  
        // 参数化类型的参数也是类型引用位置（类型变量除外）
        for (const arg of right.args ?? []) {
            if (!isVariable(arg)) this.visitTypeRef(arg)
        }
    }
    visitInstRef(term: Term) {
        label(term, "inst")
        const right = this.visitQualifiedTerm(term)
        // 内置 inst（ground/any/free/...）标 inst 但不进 instReference
        if (builtinInsts.has(right.name)) return

        // 参数化 inst 的参数也是 inst 引用位置（变量除外）
        for (const arg of right.args ?? []) {
            if (!isVariable(arg)) this.visitInstRef(arg)
        }
    }
    visitModeRef(term: Term) {
        label(term, "mode")
        const right = this.visitQualifiedTerm(term)
        // 内置模式（in/out/di/uo/ui/muo）标 mode 但不进 modeReference
        if (builtinModes.has(right.name)) return

        // 参数化模式的参数是 inst 引用位置（如 in(node) 的 node），由调用方处理
    }
    // 高阶模式 `func(M1, ...) = R is Det` / `pred(M1, ...) is Det`：
    // 参数是 mode 引用位置，确定性标 determinism；非高阶形式返回 false
    visitHigherOrderMode(term: Term): boolean {
        let expr = term
        if (nameArity(expr, "is/2")) {
            this.visitDeterminism(expr.args[1])
            expr = expr.args[0]
        }
        if (nameArity(expr, "=/2") && ["func", "function"].includes(expr.args[0]?.name)) {
            for (const a of [...(expr.args[0].args ?? []), expr.args[1]]) {
                if (!isVariable(a)) this.visitModeRef(a)
            }
            return true
        }
        if (["pred", "predicate"].includes(expr.name)) {
            for (const a of expr.args ?? []) {
                if (!isVariable(a)) this.visitModeRef(a)
            }
            return true
        }
        return false
    }

    visitFuncDeclFunc(func: Term) {
        const head = this.visitQualifiedTerm(func)
        label(head, "func")

    }


    visitDecl(term: Term) {

        switch (term.nameArity) {
            case "pred/1":
                this.visitPredDecl(term.args[0])
                break
            case "func/1":
                this.visitFuncDecl(term.args[0])
                break
            case "<=/2":
                // 带类型类约束的声明：decl <= Constraint（如 pred ... is det <= diet_element(T)）
                this.visitDecl(term.args[0])
                break
            case "impure/1":
            case "semipure/1":
            case "pure/1":
                // 声明级 purity 前缀是关键字：跳过词头，递归声明本体
                this.visitDecl(term.args[0])
                break
            case "use_module/1":
                this.visitUseModuleDecl(term.args[0])
                break
            case "import_module/1":
                this.visitImportModuleDecl(term.args[0])
                break
            case "include_module/1":
                this.visitIncludeModuleDecl(term.args[0])
                break
            case "module/1":
                this.visitModuleDecl(term.args[0])
                break
            case "end_module/1":
                this.visitEndModuleDecl(term.args[0])
                break
            case "type/1":
                this.visitTypeDeclOrDef(term.args[0])
                break
            case "interface/0":
                this.visitInterfaceDecl(term)
                break
            case "implementation/0":
                this.visitImplementationDecl(term)
                break
            case "solver/1": {
                let arg = term.args[0]
                if (nameArity(arg, 'type/1')) {
                    this.visitTypeDeclOrDef(arg.args[0])
                }
                break
            }
            case "inst/1":
                this.visitInstDecl(term.args[0])
                break
            case "mode/1":
                this.visitModeDecl(term.args[0])
                break
            case "typeclass/1":
            case "typesclass/1":
                this.visitTypeclassDecl(term.args[0])
                break
            case "instance/1":
                this.visitInstanceDecl(term.args[0])
                break
            case "abstract_mode/1":
                this.visitModeDecl(term)
                break
            case "pragma/1":
                this.visitPragmaDecl(term.args[0])
                break
            case "promise/1":
                this.visitPromiseDecl(term)
                break
            case "initialise/1":
                this.visitInitialiseDecl(term)
                break
            case "finalise/1":
                this.visitFinaliseDecl(term)
                break
            case "mutable/1":
                this.visitMutableDecl(term)
                break
            default:
                break
        }
    }

    visitTypeDeclOrDef(term: Term) {
        // Discriminated unions (可能带 where 属性块： ---> ctors where [...])
        if (nameArity(term, "--->/2")) {
            let head = term.args[0]
            let ctors = term.args[1]
            if (nameArity(ctors, "where/2")) {
                // DU 的 where 块是 where/2(ctors, attrs)：取构造子列表，属性块暂不索引
                ctors = ctors.args[0]
            }
            // 子类型形式 type T =< Super ---> ...：head 是 =</2
            if (nameArity(head, "=</2")) {
                this.visitTypeName(head.args[0])
                this.visitTypeRef(head.args[1])

                this.visitTypeConstrutors(ctors)

            } else {
                this.visitTypeName(head)

                this.visitTypeConstrutors(ctors)

            }
        }
        // Equivalence types: type T == U （U 是类型引用）
        else if (nameArity(term, "==/2")) {
            this.visitTypeName(term.args[0])
            this.visitTypeRef(term.args[1])



        }
        // 纯子类型声明（无 ---> 构造子体）： type T =< Super.
        else if (nameArity(term, "=</2")) {
            this.visitTypeNameOrSubtype(term)

        }
        // where 属性块：type T where [...] / solver type T where [...] / type T =< Super where [...]
        else if (nameArity(term, "where/2")) {
            const inner = term.args[0]
            if (nameArity(inner, "=</2")) this.visitTypeNameOrSubtype(inner)
            else this.visitTypeName(inner)

        }
        else {
            // Abstract types
            this.visitTypeDeclType(term)

        }
    }
    visitTypeDeclType(term: Term) {
        this.visitTypeName(term)
    }
    // 开始收集一个类型定义，返回 TypeInfo（构造子通过 currentType 追加）


    visitTypeConstrutors(term: Term) {
        let list = stream(semicolonBinaryTermToList(term))
        list.forEach(x => {
            this.visitTypeConstrutor(x)
        })
    }
    visitTypeConstrutor(term: Term) {
        // 存在量词构造函数 some [X] c(X) ; 跳过量词词头，标注真正的构造子
        if (["some/2", "all/2"].includes(term.nameArity)) {
            this.visitTypeConstrutor(term.args[1])
            return
        }
        // C1/C2 是 data constructor，不是 type；单独标 constructor 以便与类型名区分
        label(term, "constructor")
        const args = (term.args ?? []).map(a => this.termToSignature(a))
        // 构造子的结果类型统一是所属类型应用其参数
        const result = this.currentTypeSignature ?? typeType(term.name, [])
        this.addSymbol(term, 'constructor', constructorType(term.name, args, result))

        // interface 段的具体类型，其构造子也是模块导出符号
        // （如 pair 的 `-`/2：与 int 的减法函数 `-`/2 同名，linker 消解时两者都
        // 出现在候选里，类别不唯一则保持无类别，避免把 `K - V` 误标成 func）
        this.tryAddExport(term)
        // 收集构造子签名（参数类型 + 结果类型 = 所属类型应用其参数）
        
        // 构造子参数是类型引用位置（类型变量除外）
        for (const arg of term.args ?? []) {
            if (!isVariable(arg)) this.visitTypeRef(arg)
        }
    }
    visitTypeNameOrSubtype(term: Term) {
        if (nameArity(term, "=</2")) {
            let [subtype, rest] = term.args
            this.visitTypeName(subtype)
            // rest 可能是 '--->/2'(Super, ctors) 或直接的超类型项
            if (nameArity(rest, "--->/2")) {
                this.visitTypeRef(rest.args[0])
                this.visitTypeConstrutors(rest.args[1])
            } else {
                this.visitTypeRef(rest)
            }
        } else {
            this.visitTypeName(term)
        }
    }
    visitTypeName(term: Term) {
        label(term, "type")
        const signature = typeType(term.name, (term.args ?? []).map(a => this.termToSignature(a)))
        this.currentTypeSignature = signature
        this.addSymbol(term, 'type', signature)

        this.tryAddExport(term)

    }


    visitIncludeModuleDecl(term: Term) {
        for (const moduleTerm of commaSeparatedTermToList(term)) {
            let module = this.visitModule(moduleTerm)

            this.addImport(module, 'include_module')
        }
    }

    visitImportModuleDecl(term: Term) {
        for (const moduleTerm of commaSeparatedTermToList(term)) {
            let module = this.visitModule(moduleTerm)

            this.addImport(module, 'import_module')
        }
    }
    visitUseModuleDecl(term: Term) {
        for (const moduleTerm of commaSeparatedTermToList(term)) {
            let module = this.visitModule(moduleTerm)

            this.addImport(module, 'use_module')
        }
    }
    visitImplementationDecl(decl: Term) {
        // 之前误写成比较表达式，导致 end_module 之后的声明仍被当成 interface 段导出
        this.section = "implementation"
    }
    visitInterfaceDecl(decl: Term) {
        this.section = "interface"
    }
    visitModuleDecl(term: Term) {
        if (!this.module) {
            this.module = this.visitQualifiedModule(term)
            this.currentModule = moduleQualifiedName(this.module)
        }
        this.visitModule(term)
    }
    visitEndModuleDecl(term: Term) {
        let module = this.visitModule(term)

        // end_module 收尾 interface 段：之后的声明属于实现段，不再标记导出
        this.section = undefined
    }
    visitModule(term: Term) {
        let right = this.visitQualifiedModule(term)
        label(right, "module")
        this.addSymbol(right, 'module')
        return right
    }

    visitQualifiedTerm(term: Term) {
        if (nameArity(term, "./2")) {
            let [left, right] = term.args
            right.qualified = left
            let module = this.visitQualifiedModule(left)
            label(module, "module")

            return right
        }
        return term
    }
    visitQualifiedModule(term: Term) {
        if (nameArity(term, "./2")) {
            let [left, right] = term.args
            right.qualified = left
            let module = this.visitQualifiedModule(left)
            label(module, "module")

            return right
        }
        if (term.arity !== 0) {
            this.addError("module term's arity should be zero", term)
        }
        return term
    }

    visitMutableDecl(decl: Term) {
        let [varTerm, typeTerm] = decl.args
        label(varTerm, "mutable")

        if (typeTerm) {
            this.visitTypeRef(typeTerm)
        }
    }
    visitFinaliseDecl(decl: Term) {
        this.visitInitFinaliseRef(decl)
    }
    visitInitialiseDecl(decl: Term) {
        this.visitInitFinaliseRef(decl)
    }
    // `:- initialise p/2.` / `:- finalise p/2.`：PredName 是 pred 引用（Name/Arity 形式）
    visitInitFinaliseRef(decl: Term) {
        const target = decl.args[0]
        if (!target) return
        if (this.visitNameArityRef(target)) return

    }
    visitPromiseDecl(decl: Term) {
        // :- promise <Goal>. 把目标体当普通 goal 遍历以索引其中的引用
        this.visitRuleBody(decl.args[0])
    }
    visitPragmaDecl(decl: Term) {
        label(decl, "pragma")
        // pragma 引用的 pred/func/constructor 位置索引（§14）：
        // - inline/no_inline/obsolete/obsolete_proc/promise_pure/type_spec/foreign_export:
        //   参数是 Name/Arity（pred/func 引用）
        // - foreign_proc: 第 2 参是过程头 `p(X::in, Y::out)`（functor 即 pred 引用）
        // - foreign_export_enum: 第 2 参是枚举构造子 Name/Arity
        if (decl.name === "foreign_proc") {
            let head = decl.args?.[1]
            if (head && !isVariable(head) && head.syntaxType !== "string") {
                // 函数形式 `init(N::in, X::in) = (VA::out)` 的头是 =/2(FuncHead, RetMode)：
                // 解包取函数头标 func；pred 形式 `p(X::in, Y::out)` 标 pred
                const isFunc = nameArity(head, "=/2")
                if (isFunc) head = head.args[0]
                if (head && !isVariable(head)) {
                    label(head, isFunc ? "func" : "pred")
                }
            }
            return
        }
        if (decl.name === "foreign_export_enum") {
            const ctor = decl.args?.[1]
            if (ctor && nameArity(ctor, "//2") && ctor.args[0] && !isVariable(ctor.args[0])) {
                const n = Number.parseInt(ctor.args[1]?.name ?? '', 10)
                const nameTerm = ctor.args[0]
                if (!Number.isNaN(n)) nameTerm.semanticArity = n
            }
            return
        }
        for (const arg of decl.args ?? []) {
            this.visitPragmaArgRef(arg)
        }
    }
    visitPragmaArgRef(term: Term) {
        if (isVariable(term)) return
        if (this.visitNameArityRef(term)) return
        // 其它结构参数（属性列表等）不索引
    }

    visitTypeclassDecl(term: Term) {
        // body 形如 where/2(Head, Methods)、<=/2(Inner, Supers) 或 where/2(<=/2(...), Methods)
        // 先定位 where 节点以索引方法，再剥离 where/2、<=/2 得到类名项（diet_element/1）
        let whereTerm: Term | undefined
        let probe = term
        for (let i = 0; i < 6 && probe; i++) {
            if (nameArity(probe, "where/2")) { whereTerm = probe; break }
            if (nameArity(probe, "<=/2")) { probe = probe.args[0]; continue }
            break
        }
        let classTerm = term
        for (let i = 0; i < 6 && (nameArity(classTerm, "where/2") || nameArity(classTerm, "<=/2")); i++) {
            classTerm = classTerm.args[0]
        }
        label(classTerm, "typeclass")

        this.tryAddExport(classTerm)
        // 递归索引 where 块里的方法签名（pred/func/mode 声明）
        if (whereTerm) {
            for (const method of listToTerms(whereTerm.args[1])) {
                if (nameArity(method, "pred/1")) {
                    this.visitPredDecl(method.args[0])
                } else if (nameArity(method, "func/1")) {
                    this.visitFuncDecl(method.args[0])
                } else if (nameArity(method, "mode/1")) {
                    this.visitModeDecl(method.args[0])
                }
            }
        }
    }
    visitInstanceDecl(term: Term) {
        // instance ClassName(Type) [<= ...] [where [...]]，结构同 typeclass
        let whereTerm: Term | undefined
        let probe = term
        for (let i = 0; i < 6 && probe; i++) {
            if (nameArity(probe, "where/2")) { whereTerm = probe; break }
            if (nameArity(probe, "<=/2")) { probe = probe.args[0]; continue }
            break
        }
        let head = term
        for (let i = 0; i < 6 && (nameArity(head, "where/2") || nameArity(head, "<=/2")); i++) {
            head = head.args[0]
        }
        label(head, "instance")

        // 实例化的类型参数是类型引用位置（类型变量除外）
        for (const arg of head.args ?? []) {
            if (!isVariable(arg)) this.visitTypeRef(arg)
        }
        if (whereTerm) {
            for (const method of listToTerms(whereTerm.args[1])) {
                if (nameArity(method, "pred/1")) {
                    this.visitPredDecl(method.args[0])
                } else if (nameArity(method, "func/1")) {
                    this.visitFuncDecl(method.args[0])
                } else if (nameArity(method, "mode/1")) {
                    this.visitModeDecl(method.args[0])
                }
            }
        }
    }
    visitModeDecl(term: Term) {
        if (nameArity(term, "==/2")) {
            this.recordModeDef(term.args[0], term.args[1])
            this.visitModeName(term.args[0])
            // `mode M == InstA >> InstB`：两侧都是 inst 引用位置（§5.2/5.3）；
            // 跳过高阶模式 pred(...)/func(...) 头
            const body = term.args[1]
            if (nameArity(body, ">>/2")) {
                for (const side of body.args) {
                    if (!isVariable(side) && !['pred', 'predicate', 'func', 'function'].includes(side.name)) {
                        this.visitInstRef(side)
                    }
                }
            }
        } else if (nameArity(term, "is/2")) {
            const head = this.visitQualifiedTerm(term.args[0]) ?? term.args[0]
            this.visitFuncOrPredModeDecl(head, detOf(term.args[1]))
        } else {
            const head = this.visitQualifiedTerm(term) ?? term
            if (head.semanticArity > 0 && !isVariable(head) ) {
                // `:- mode P(Modes).`（无确定性后缀）的 pred/func-mode 声明；
                // 与抽象 mode 声明（:- mode M.，通常 arity 0 或非 pred/func 名）区分
                this.visitFuncOrPredModeDecl(head)
            } else {
                // abstract_mode M.
                this.visitModeName(term)
            }
        }
    }
    visitModeName(term: Term) {
        label(term, "mode")
        this.addSymbol(term, 'mode')

        this.tryAddExport(term)
    }
    visitFuncOrPredModeDecl(term: Term, determinism?: string) {
        if (nameArity(term, "=/2")) {
            this.visitFuncMode(term, determinism)
        } else {
            this.visitPredMode(term, determinism)
        }
    }
    // pred-mode 声明 `:- mode P(Modes) [is Det].`：显式声明该 pred 的一条过程 mode。
    // 替换 modeSigs 默认行（Mercury：有显式声明时默认 mode 不适用）、追加到签名
    // modes 列表（多过程），首个声明覆盖 argModeRefs（子句侧单 mode 近似与跨模块展示用）
    visitPredMode(term: Term, determinism?: string) {
        const head = this.visitQualifiedTerm(term) ?? term
        label(head, "pred")
        const key = keyOf(head.name, head.semanticArity)
        const refs = head.args.map(modeTermToRef)


        const det = determinism ? ` is ${determinism}` : ''
        this.pushModeSigReplacingDefault(
            key, `${head.name}(${head.args.map(a => this.modeArgToString(a)).join(', ')})${det}`)
    }
    // func-mode 声明 `:- mode f(Modes) = (Mode) [is Det].`
    visitFuncMode(term: Term, determinism?: string) {
        const headTerm = this.visitQualifiedTerm(term.args[0]) ?? term.args[0]
        const head = headTerm
        label(head, "func")
        const key = keyOf(head.name, head.semanticArity)
        const refs = head.args.map(modeTermToRef)
        const retRef = modeTermToRef(term.args[1])


        const det = determinism ? ` is ${determinism}` : ''
        this.pushModeSigReplacingDefault(
            key, `${head.name}(${head.args.map(a => this.modeArgToString(a)).join(', ')})` +
        ` = (${this.modeArgToString(term.args[1])})${det}`)
    }
    // mode 声明参数 → 展示串（in / array_ui / in(node)）
    private modeArgToString(t: Term): string {
        if (isVariable(t)) return t.name
        if (t.args.length === 0) return t.name
        return `${t.name}(${t.args.map(a => this.modeArgToString(a)).join(', ')})`
    }
    visitMode(term: Term) {
        label(term, "mode")
    }
    visitInstDecl(term: Term) {
        if (nameArity(term, "==/2")) {
            this.recordInstDef(term.args[0], instTermToMerInst(term.args[1]))
            this.visitInstOrForBlock(term.args[0])
            this.visitInstOrBound(term.args[1])
        } else if (nameArity(term, "--->/2")) {
            this.recordInstDef(term.args[0], { kind: 'bound', functors: instFunctorAlts(term.args[1]) })
            this.visitInstOrForBlock(term.args[0])
            this.visitInsts(term.args[1])
        } else {
            // abstract_inst I.
            this.visitInstName(term)
        }
    }
    // :- inst I == Expr / :- inst I ---> f ; g 结构化入库（Phase A）
    private recordInstDef(headTerm: Term, body: MerInst) {
        const head = instDefHead(headTerm)
    }
    visitInsts(term: Term) {
        for (const inst of semicolonBinaryTermToList(term)) {
            this.visitInstName(inst)
        }
    }
    visitInstOrBound(term: Term) {
        if (nameArity(term, "bound/2")) {
            // bound(f(...) ; g(...)) 内的 inst 构造子是使用而非定义
            // TODO: 递归标注 bound 内的 inst 引用
        } else {
            this.visitInst(term)
        }
    }
    visitInstOrForBlock(term: Term) {
        if (nameArity(term, "for/2")) {
            this.visitInstName(term.args[0])
            // `inst I for Type/Arity`：Type 是类型引用位置（Type/Arity 解析为 //2(Type, Arity)）
            const typeSpec = term.args[1]
            if (nameArity(typeSpec, "//2") && typeSpec.args[0] && !isVariable(typeSpec.args[0])) {
                // Type 语法上是 0 元原子（arity 0），语义元数取 Type/Arity 的 Arity
                const semanticArity = Number.parseInt(typeSpec.args[1]?.name ?? '', 10)
                if (!Number.isNaN(semanticArity)) {
                    typeSpec.args[0].semanticArity = semanticArity
                }
                this.visitTypeRef(typeSpec.args[0])
            }
        } else {
            this.visitInstName(term)
        }
    }
    visitInstName(term: Term) {
        label(term, "inst")
        this.addSymbol(term, 'inst')
        this.tryAddExport(term)
    }
    visitInst(term: Term) {
        label(term, "inst")
    }
    visitFuncDecl(term: Term, determinism?: string) {
        if (nameArity(term, "is/2")) {
            // :- func F(...) = R is det.  →  标 F，确定性记入 mode 行
            this.visitFuncDecl(term.args[0], detOf(term.args[1]))
        } else if (nameArity(term, "=/2")) {
            let [func, ret] = term.args
            const head = this.visitQualifiedTerm(func)
            this.visitFuncDeclFunc(head)
            this.visitTypeParams(head)
            this.visitFuncReturn(ret)
            this.recordFuncInfo(head, ret, determinism)
        } else {
            const head = this.visitQualifiedTerm(term) ?? term
            this.visitFuncDeclFunc(head)
            this.visitTypeParams(head)
            this.recordFuncInfo(head, undefined, determinism)
        }
    }
    // pred f(A,B,C) [is det]
    visitPredDecl(term: Term) {
        if (nameArity(term, "is/2")) {
            let [pred, det] = term.args
            const head = this.visitQualifiedTerm(pred) ?? pred
            label(head, "pred")
            this.visitTypeParams(head)
            this.visitDeterminism(det)
            this.recordPredInfo(head, detOf(det))
        } else {
            const head = this.visitQualifiedTerm(term) ?? term
            label(head, "pred")
            this.visitTypeParams(head)
            this.recordPredInfo(head)
        }
    }
    // 声明是否带显式 mode 注解（任一参数 ::/>> 或返回值 ::/>>；Phase D 推断目标判据）
    private hasExplicitModes(args: Term[], ret?: Term): boolean {
        const annotated = (t: Term) => t.nameArity === '::/2' || t.nameArity === '>>/2'
        return args.some(annotated) || (!!ret && annotated(ret))
    }
    /** 类型表达式 → MerType：变量、参数化类型、`::`/`>>` mode 注解统一在这里转换 */
    private termToSignature(term: Term): MerType {
        if (isVariable(term)) return varType(term.name)
        if (term.nameArity === '::/2' || term.nameArity === '>>/2') {
            return this.termToSignature(term.args[0])
        }
        // 模块限定类型 `M.Type(Args)` 解析为 `./2(M, Type(Args))`：
        // 签名里只保留类型本身，否则 `list.list(float)` 会变成名为 `.` 的类型，
        // 无法与构造子的结果类型 `list(T)` 合一。
        if (term.nameArity === './2') {
            return this.termToSignature(term.args[1])
        }
        return typeType(term.name, (term.args ?? []).map(a => this.termToSignature(a)))
    }
    private recordFuncInfo(func: Term, ret: Term | undefined, determinism?: string) {
        const argRefs = func.args.map(a => this.argModeRefOf(a))
        const retRef = ret ? this.retModeRefOf(ret) : undefined
        const type: MerType = {
            kind: 'func',
            name: func.name,
            args: func.args.map(a => this.termToSignature(a)),
            result: ret ? this.termToSignature(ret) : undefined,
        }
        this.addSymbol(func, 'func', type)
        // 每个 mode 声明一行（Mercury 默认 mode：参数 in，函数结果 out）；带确定性后缀
        const modes = func.args.map(modeOfArg).map(m => m ?? 'in')
        const rm = ret ? modeOfArg(ret) ?? 'out' : 'out'
        const det = determinism ? ` is ${determinism}` : ''
        this.pushModeSig(keyOf(func.name, func.semanticArity), `${func.name}(${modes.join(', ')}) = (${rm})${det}`)
    }
    // 记录谓词签名（name/arity → 参数类型/mode；谓词无返回类型）
    private recordPredInfo(pred: Term, determinism?: string) {
        const argRefs = pred.args.map(a => this.argModeRefOf(a))
        const type: MerType = {
            kind: 'pred',
            name: pred.name,
            args: pred.args.map(a => this.termToSignature(a)),
        }
        this.addSymbol(pred, 'pred', type)
    }
    // :- mode I == Init >> Final 结造化入库（Phase A）；mode 别名 `I == Body`（Body 是单个
    // mode 引用，如 array.m 的 `:- mode array_uo == out(uniq_array).`）记 alias 引用，
    // 由 modeRefToInsts 惰性解引用（别名可能指向尚未收集的其它用户 mode）；高阶模式体
    //（pred(...)/func(...)）暂不收集
    private recordModeDef(headTerm: Term, body: Term) {
        const head = instDefHead(headTerm)
        if (!head || isVariable(body)) return
        if (body.nameArity === '>>/2') {
            
            return
        }
        if (['pred', 'predicate', 'func', 'function'].includes(body.name)) return

    }
    // 声明参数 → 结构化 mode 引用（未注解默认 in）
    private argModeRefOf(arg: Term): MerModeRef {
        if (arg.nameArity === '::/2' || arg.nameArity === '>>/2') return modeTermToRef(arg.args[1])
        return { kind: 'builtin', name: 'in', args: [] }
    }
    // 函数返回值 → 结构化 mode 引用（= (T::out) 取注解；= T 默认 out）
    private retModeRefOf(ret: Term): MerModeRef {
        if (ret.nameArity === '::/2' || ret.nameArity === '>>/2') return modeTermToRef(ret.args[1])
        return { kind: 'builtin', name: 'out', args: [] }
    }
    private pushModeSig(key: string, line: string) {

    }
    // 显式 pred/func-mode 声明 → modeSigs：首个声明替换 recordPred/FuncInfo 推出的默认行
    //（Mercury：有显式 mode 声明时默认 mode 不适用），同一 pred 的后续声明追加
    private modeSigReplaced = new Set<string>()
    private pushModeSigReplacingDefault(key: string, line: string) {
        if (this.modeSigReplaced.has(key)) {
            this.pushModeSig(key, line)
            return
        }

        this.modeSigReplaced.add(key)
    }
    // 声明参数与函数返回值共用：Type / Type :: Mode / Type >> Mode，Type 是类型引用位置
    visitTypeParams(head: Term) {
        for (const param of head.args ?? []) this.visitTypeParam(param)
    }
    visitTypeParam(param: Term) {
        if (nameArity(param, "::/2") || nameArity(param, ">>/2")) {
            if (!isVariable(param.args[0])) this.visitTypeRef(param.args[0])
            // `::`/`>>` 右侧是 mode 位置：整个标 mode 进 modeReference
            // （如 `T :: node` 的 node、`T :: in(node)` 的 in）；
            // 参数化模式的参数是 inst 引用位置（如 in(node) 的 node）
            const modePart = param.args[1]
            if (!isVariable(modePart)) {
                this.visitModeRef(modePart)
                for (const arg of modePart.args ?? []) {
                    if (isVariable(arg)) continue
                    // 高阶模式 func(M1,...) = R is Det / pred(M1,...) is Det：
                    // 其参数是 mode 引用位置
                    if (this.visitHigherOrderMode(arg)) continue
                    this.visitInstRef(arg)
                }
            }
        } else if (!isVariable(param)) {
            this.visitTypeRef(param)
        }
    }

    /** 阶段 2b：区分 import_module / use_module / include_module，并记录所在 section */
    addImport(module: Term, kind: ImportKind = 'import_module') {
        this.imports.push(module)
        this.moduleImports.push({
            kind,
            module: moduleQualifiedName(module),
            term: module,
            section: this.section,
        })
    }
    addError(msg: string, term: Term) {
        this.errors.push(Diagnostic.create(
            term.range,
            msg,
            DiagnosticSeverity.Error,
            undefined,
            'visitor'
        ))
    }
    addCalled(term: Term) {
        term.clause = this.currentClause
        this.currentClause.called.push(term)
    }
    addCallee(term: Term) {
        term.clause = this.currentClause
        this.currentClause.callee = term
    }
    tryAddExport(term: Term) {
        if (this.section !== "interface") return
        for (const s of this.currentSymbols) {
            if (s.term === term && s.kind !== 'module') s.exported = true
        }
    }
    visitDeterminism(determinism: Term) {
        label(determinism, "determinism")
    }
    visitSolverDecl(decl: Term) {
        if (decl.arity === 1 && decl.args[0].name === "type") {
            this.visitSolverTypeDecl(decl.args[0])
        }
    }
    visitSolverTypeDecl(arg0: Term) {
        this.visitTypeDeclOrDef(arg0.args[0])
    }

}


// ===== 内置常量 =====

// 内置模式名：标 mode 但不进 modeReference
const builtinModes = new Set(["in", "out", "di", "uo", "ui", "muo"])
// 内置 inst 名：标 inst 但不进 instReference
const builtinInsts = new Set([
    "ground", "any", "free", "unique", "mostly_unique", "mostly_uniq",
    "clobbered", "mostly_clobbered", "clobbered_any", "unique_any",
    "mostly_unique_any", "not_reached", "bound_unique",
])

// determinism 项 → 字符串（det/semidet/cc_multi... 均为原子；缺省 undefined）
function detOf(term: Term | undefined): string | undefined {
    return term?.name
}



function nameArity(term: Term, nameArity: string) {
    return term.nameArity == nameArity
}
function name(term: Term, name: string) {
    return term.name === name
}
function arity(term: Term, arity: number) {
    return term.semanticArity === arity
}
function* semicolonBinaryTermToList(term: Term) {
    for (; ;) {
        if (nameArity(term, ";/2")) {
            yield term.args[0]
            term = term.args[1]
        } else {
            yield term
            break;
        }
    }
    return undefined
}

function* commaSeparatedTermToList(term: Term) {
    for (; ;) {
        if (nameArity(term, ",/2")) {
            yield term.args[0]
            term = term.args[1]
        } else {
            yield term
            break;
        }
    }
    return undefined
}

function* listToTerms(term: Term) {
    for (; ;) {
        if (nameArity(term, "[|]/2")) {
            yield term.args[0]
            term = term.args[1]
        } else if (nameArity(term, "[]/0")) {
            break
        } else {
            yield term
            break
        }
    }
    return undefined
}

export function label(term: Term, semanticType: SemanticType) {
    term.semanticType = semanticType
}

function isVariable(term: Term) {
    return term.syntaxType === "variable"
}
function isSpecialDataTerm(term: Term): boolean {
    return (isConditionalExpr(term)
        || isRecordSyntexExpr(term)
        || isUnificationExpr(term)
        || isLambdaExpr(term)
        || isHigerOrderFuncApplication(term)
        || isExplicitTypeQualification(term)) ?? false
}

function isConditionalExpr(term: Term) {
    if (["else/2", ";/2", "->/2", "if/3"].includes(term.nameArity)) {
        label(term, "conditional")
        return true;
    }
}

function isRecordSyntexExpr(term: Term) {
    if (["^/2", ":=/2", "=^/2"].includes(term.nameArity)) {
        label(term, "record")
        return true
    }
}

function isUnificationExpr(term: Term) {
    if (term.nameArity === "@/2") {
        label(term, "unification")
        return true
    }
}
function isHigerOrderFuncApplication(term: Term) {
    if (term.name === "apply" && term.arity > 0) {
        label(term, "apply")
        return true
    }
}

function isExplicitTypeQualification(term: Term) {
    if ([":/2", "with_type/2"].includes(term.nameArity)) {
        label(term, "explicitType")
        return true
    }
}

function isLambdaExpr(term: Term) {
    if ([":-/2", "-->/2"].includes(term.nameArity)) {
        label(term, "lambda")
        return true
    }
}

export type SemanticType =
    "func" |
    "pred" |
    "type" |
    "constructor" |
    "fieldname" |
    "inst" |
    "mode" |
    "module" |
    "variable" |
    "float" |
    "integer" |
    "string" |
    "typeclass" |
    "instance" |
    "pragma" |
    "mutable" |
    "determinism" |
    "operator" |
    "implementationDefined" |
    SpecialDataTerm
export type SpecialDataTerm =
    'conditional' |
    "record" |
    "apply" |
    "lambda" |
    "unification" |
    "explicitType"

