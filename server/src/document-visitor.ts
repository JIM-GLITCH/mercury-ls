import { CancellationToken, Diagnostic, DiagnosticSeverity } from 'vscode-languageserver'
import { MercuryDocument } from './document-manager'
import { MultiMap } from './multimap'
import { TreeStreamImpl, stream } from './stream'
import { Clause, RootNode, Term } from './term'
import { sameArity } from './utils'
import { interruptAndCheck } from './promise-util'
import { ExportManager, ModuleManager } from './document-moduleManager'
import type { MercuryServices } from './services'
import {
    applySubst, ConsInfo, FuncInfo, InferredInfo, MerType, TypeCtor, TypeInfo,
    keyOf, keyOfTypeCtor, modeOfArg, argModesOf, termToMerType, unify,
} from './document-type'
import {
    instTermToMerInst, instFunctorAlts, modeTermToRef, instDefHead,
    type MerInst, type InstDef, type ModeDef, type MerModeRef,
} from './document-mode'

// 内置模式名：标 mode 但不进 modeReference
const builtinModes = new Set(["in", "out", "di", "uo", "ui", "muo"])
// 内置 inst 名：标 inst 但不进 instReference
const builtinInsts = new Set([
    "ground", "any", "free", "unique", "mostly_unique", "mostly_uniq",
    "clobbered", "mostly_clobbered", "clobbered_any", "unique_any",
    "mostly_unique_any", "not_reached", "bound_unique",
])
export type VisitResult = {
    module?:Term
    errors:Diagnostic[]
    definition: MultiMap<string,Term>,
    reference:MultiMap<string,Term>,
    typeReference:MultiMap<string,Term>,
    instReference:MultiMap<string,Term>,
    modeReference:MultiMap<string,Term>,
    declaration:MultiMap<string,Term>,
    exports:MultiMap<string,Term>
    imports:Term[]
    // 类型推断基础数据（阶段 0+1 收集，尚未用于 link 消歧）
    types:Map<string, TypeInfo>          // 类型构造子 → 类型定义（含构造子列表）
    funcs:Map<string, FuncInfo>          // 函数签名（name/arity → 参数+返回类型）
    preds:Map<string, FuncInfo>          // 谓词签名（name/arity → 参数类型）
    // name/arity → mode 声明展示串（每个声明一行，如 add(in, in) = (out)；未注解用默认 in/out）
    modeSigs:Map<string, string[]>
    // Phase A：:- inst / :- mode 声明的结构化表示（mode 分析用）
    instDefs:Map<string, InstDef>
    modeDefs:Map<string, ModeDef>
    // 阶段 2 推断结果：项 → 推断类型/类别（供 linker 精确消歧 functor/func）
    inferred:Map<Term, InferredInfo>
}
// determinism 项 → 字符串（det/semidet/cc_multi... 均为原子；缺省 undefined）
function detOf(term: Term | undefined): string | undefined {
    return term?.name
}

export class Visitor {
    /** 未显式注入容器时，用一套全新的空索引，绝不共享全局状态 */
    protected readonly moduleManager: ModuleManager
    protected readonly exportManager: ExportManager
    constructor(services?: MercuryServices) {
        this.moduleManager = services?.moduleManager ?? new ModuleManager()
        this.exportManager = services?.exportManager ?? new ExportManager()
    }
    module?:Term
    imports=[] as Term[]
    section?:string  
    currentClause!: Clause
    errors: Diagnostic[] = []
    definition = new MultiMap<string, Term>()
    reference = new MultiMap<string, Term>()
    typeReference = new MultiMap<string, Term>()
    instReference = new MultiMap<string, Term>()
    modeReference = new MultiMap<string, Term>()
    declaration = new MultiMap<string, Term>()
    exports= new MultiMap<string, Term>()
    types = new Map<string, TypeInfo>()
    funcs = new Map<string, FuncInfo>()
    preds = new Map<string, FuncInfo>()
    modeSigs = new Map<string, string[]>()
    instDefs = new Map<string, InstDef>()
    modeDefs = new Map<string, ModeDef>()
    inferred = new Map<Term, InferredInfo>()
    // 正在收集的类型定义（visitTypeConstrutor 往里追加构造子）
    private currentType?: TypeInfo
    // 类型推断工作态（每个子句重置）
    private subst = new Map<string, MerType>()
    private varTypes = new Map<string, MerType>()
    // 变量子句级 mode 近似（head 形参声明 mode / 绑定变量 out / 调用 in 实参；类型推断步骤填充，供 hover 显示）
    private varMode = new Map<string, string>()
    private varCounter = 0
    async visit(doc: MercuryDocument, cancelToken: CancellationToken) {
        this.errors = []
        let rootNode = doc.parseResult.value
        for (const clause of rootNode.args) {
            await interruptAndCheck(cancelToken)
            this.visitClause(clause)
        }
        doc.visitResult = {
            module:this.module,
            errors:this.errors,
            definition:this.definition,
            reference:this.reference,
            typeReference:this.typeReference,
            instReference:this.instReference,
            modeReference:this.modeReference,
            declaration:this.declaration,
            exports:this.exports,
            imports:this.imports,
            types:this.types,
            funcs:this.funcs,
            preds:this.preds,
            modeSigs:this.modeSigs,
            instDefs:this.instDefs,
            modeDefs:this.modeDefs,
            inferred:this.inferred
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
        // 阶段 2：子句级类型推断（声明/签名已在同模块前序收集；不抛错、不影响索引）
        this.inferClause(clause)
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
            case "=^/2":{
                this.visitDataTerm(term.args[0]);
                this.visitFieldList(term.args[1], 'select');
                break;
            }
            case ":=/2": {
                if(nameArity(term.args[0],"^/1")){
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
        if(isVariable(term)){
            this.visitVariable(term);
        } else if(isSpecialDataTerm(term)){
            this.visitSpecialDataTerm(term)
        } else {
            this.visitDataFunctor(term);
        }
    }
    visitDataFunctor(term: Term) {
        switch(term.syntaxType){
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
        this.addReference(rightTerm)
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
        this.addReference(nameTerm)
        return true
    }
    visitFloat(term: Term) {
        label(term,"float")
    }
    visitInteger(term: Term) {
        label(term,"integer")
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
        this.addReference(head)
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
        label(term,"apply");
        
    }
    visitRecord(term: Term) {
        if(nameArity(term,"^/2")){
            this.visitDataTerm(term.args[0])
            this.visitFieldList(term.args[1])
        }else{
            this.visitDataTerm(term)
        }
    }
    visitString(term: Term) {
        label(term,"string")
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
        label(term,"pred")
        this.addDefinition(term)
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
            case "then/2":{
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
        label(term,"pred")
        this.addReference(term)
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
        this.addReference(term)
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
        label(head,"func")
        this.addDefinition(func)
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
                this.addDefinition(term.args[0])
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
        this.typeReference.add(right.name, right)
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
        this.instReference.add(right.name, right)
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
        this.modeReference.add(right.name, right)
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
        this.addDeclaration(head)
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
            case "implemtation/0":
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
            case "infixl/1":
            case "infixr/1":
            case "infix/1":
            case "prefix/1":
            case "postfix/1":
                this.visitOperatorDecl(term)
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
                const info = this.beginTypeInfo(head.args[0])
                this.visitTypeConstrutors(ctors)
                this.endTypeInfo(info)
            } else {
                this.visitTypeName(head)
                const info = this.beginTypeInfo(head)
                this.visitTypeConstrutors(ctors)
                this.endTypeInfo(info)
            }
        }
        // Equivalence types: type T == U （U 是类型引用）
        else if (nameArity(term, "==/2")) {
            this.visitTypeName(term.args[0])
            this.visitTypeRef(term.args[1])
            const info = this.beginTypeInfo(term.args[0])
            // 记录底层类型，供推断时展开同义词（如 assoc_list(K,V) == list(pair(K,V))）
            info.body = termToMerType(term.args[1])
            this.addTypeInfo(info)
        }
        // 纯子类型声明（无 ---> 构造子体）： type T =< Super.
        else if (nameArity(term, "=</2")) {
            this.visitTypeNameOrSubtype(term)
            this.addTypeInfo(this.beginTypeInfo(term.args[0]))
        }
        // where 属性块：type T where [...] / solver type T where [...] / type T =< Super where [...]
        else if (nameArity(term, "where/2")) {
            const inner = term.args[0]
            if (nameArity(inner, "=</2")) this.visitTypeNameOrSubtype(inner)
            else this.visitTypeName(inner)
            this.addTypeInfo(this.beginTypeInfo(inner))
        }
        else{
            // Abstract types
            this.visitTypeDeclType(term)
            this.addTypeInfo(this.beginTypeInfo(term))
        }
    }
    visitTypeDeclType(term: Term) {
        const right = this.visitQualifiedTerm(term)
        label(right, "type")
        this.addDefinition(right)
        this.tryAddExport(right)
    }
    // 开始收集一个类型定义，返回 TypeInfo（构造子通过 currentType 追加）
    private beginTypeInfo(typeHead: Term): TypeInfo {
        const tc: TypeCtor = { name: typeHead.name, arity: typeHead.arity }
        const info: TypeInfo = { ctor: tc, params: typeHead.args.map(termToMerType), constructors: [] }
        this.currentType = info
        return info
    }
    private endTypeInfo(info: TypeInfo) {
        this.addTypeInfo(info)
        this.currentType = undefined
    }
    private addTypeInfo(info: TypeInfo) {
        this.types.set(keyOfTypeCtor(info.ctor), info)
    }
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
        this.addDefinition(term)
        // interface 段的具体类型，其构造子也是模块导出符号
        // （如 pair 的 `-`/2：与 int 的减法函数 `-`/2 同名，linker 消解时两者都
        // 出现在候选里，类别不唯一则保持无类别，避免把 `K - V` 误标成 func）
        this.tryAddExport(term)
        // 收集构造子签名（参数类型 + 结果类型 = 所属类型应用其参数）
        if (this.currentType) {
            const resultType: MerType = {
                kind: 'ctor', ctor: this.currentType.ctor, args: this.currentType.params,
            }
            const ci: ConsInfo = {
                ctor: term.name, arity: term.arity,
                argTypes: term.args.map(a => termToMerType(a)),
                resultType, typeCtor: this.currentType.ctor,
            }
            this.currentType.constructors.push(ci)
        }
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
        const right = this.visitQualifiedTerm(term)
        label(right, "type")
        this.addDefinition(right)
        this.tryAddExport(right)

    }


    visitIncludeModuleDecl(term: Term) {
        for (const moduleTerm of commaSeparatedTermToList(term)) {
            let module = this.visitModule(moduleTerm)
            this.addReference(module)
            this.addImport(module)
        }
    }

    visitImportModuleDecl(term: Term) {
        for (const moduleTerm of commaSeparatedTermToList(term)) {
            let module = this.visitModule(moduleTerm)
            this.addReference(module)
            this.addImport(module)
        }
    }
    visitUseModuleDecl(term: Term) {
        for (const moduleTerm of commaSeparatedTermToList(term)) {
            let module = this.visitModule(moduleTerm)
            this.addReference(module)
            this.addImport(module)
        }
    }
    visitImplementationDecl(decl: Term) {
       this.section == "implementation"
    }
    visitInterfaceDecl(decl: Term) {
        this.section = "interface"
    }
    visitModuleDecl(term: Term) {
        let module = this.visitModule(term)
        if(!this.module){
            this.module= module
        } 
    }
    visitEndModuleDecl(term: Term) {
        let module = this.visitModule(term)
        this.addReference(module)
    }
    visitModule(term: Term) {
        let right = this.visitQualifiedModule(term)
        label(right, "module")
        return right
    }

    visitQualifiedTerm(term: Term) {
        if (nameArity(term, "./2")) {
            let [left, right] = term.args
            right.qualified = left
            let module = this.visitQualifiedModule(left)
            label(module, "module")
            this.addReference(left)
            return right
        } 
        return term
    }
    visitQualifiedModule(term:Term){
        if (nameArity(term, "./2")) {
            let [left, right] = term.args
            right.qualified = left
            let module = this.visitQualifiedModule(left)
            label(module, "module")
            this.addReference(left)
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
        this.addDefinition(varTerm)
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
        this.addReference(target)
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
                    this.addReference(head)
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
                this.addReference(nameTerm)
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
    visitOperatorDecl(decl: Term) {
        // :- infixl(Prio, Op).  Op（decl.args[1]）是被定义的运算符名
        let opTerm = decl.args[1]
        if (opTerm) {
            label(opTerm, "operator")
            this.addDefinition(opTerm)
        }
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
        this.addDefinition(classTerm)
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
        this.addDefinition(head)
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
        if(nameArity(term,"==/2")){
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
        } else if (nameArity(term,"is/2")){
            const head = this.visitQualifiedTerm(term.args[0]) ?? term.args[0]
            this.visitFuncOrPredModeDecl(head, detOf(term.args[1]))
        } else {
            const head = this.visitQualifiedTerm(term) ?? term
            if (head.semanticArity > 0 && !isVariable(head) &&
                   (this.preds.has(keyOf(head.name, head.semanticArity)) ||
                    this.funcs.has(keyOf(head.name, head.semanticArity)))) {
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
        label(term,"mode")
        this.addDefinition(term)
        this.tryAddExport(term)
    }
    visitFuncOrPredModeDecl(term: Term, determinism?: string) {
        if(nameArity(term,"=/2")){
            this.visitFuncMode(term, determinism)
        }else{
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
        const fi = this.preds.get(key)
        if (fi) {
            fi.modes = fi.modes ?? []
            fi.modes.push({ argModeRefs: refs, det: determinism })
            if (!fi.hasExplicitModes && fi.modes.length === 1) fi.argModeRefs = refs
        }
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
        const fi = this.funcs.get(key)
        if (fi) {
            fi.modes = fi.modes ?? []
            fi.modes.push({ argModeRefs: refs, resultModeRef: retRef, det: determinism })
            if (!fi.hasExplicitModes && fi.modes.length === 1) {
                fi.argModeRefs = refs
                fi.resultModeRef = retRef
            }
        }
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
        label(term,"mode")
    }
    visitInstDecl(term: Term) {
        if(nameArity(term,"==/2")){
            this.recordInstDef(term.args[0], instTermToMerInst(term.args[1]))
            this.visitInstOrForBlock(term.args[0])
            this.visitInstOrBound(term.args[1])
        }else if(nameArity(term,"--->/2")){
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
        if (head) this.instDefs.set(keyOf(head.name, head.arity), { params: head.params, body })
    }
    visitInsts(term: Term) {
        for (const inst of semicolonBinaryTermToList(term)) {
            this.visitInstName(inst)
        }
    }
    visitInstOrBound(term: Term) {
        if(nameArity(term,"bound/2")){
            // bound(f(...) ; g(...)) 内的 inst 构造子是使用而非定义
            // TODO: 递归标注 bound 内的 inst 引用
        }else{
            this.visitInst(term)
        }
    }
    visitInstOrForBlock(term: Term) {
        if(nameArity(term,"for/2")){
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
        }else{
            this.visitInstName(term)
        }
    }
    visitInstName(term: Term) {
        label(term,"inst")
        this.addDefinition(term)
        this.tryAddExport(term)
    }
    visitInst(term: Term) {
        label(term,"inst")
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

    visitPredDecl(term: Term, determinism?: string) {
        if (nameArity(term, "is/2")) {
            let [pred, det] = term.args
            const head = this.visitQualifiedTerm(pred) ?? pred
            label(head, "pred")
            this.visitTypeParams(head)
            this.visitDeterminism(det)

            this.addDeclaration(head)
            this.recordPredInfo(head, detOf(det))
        } else {
            const head = this.visitQualifiedTerm(term) ?? term
            label(head, "pred")
            this.visitTypeParams(head)
            this.addDeclaration(head)
            this.recordPredInfo(head, determinism)
        }
    }
    // 声明是否带显式 mode 注解（任一参数 ::/>> 或返回值 ::/>>；Phase D 推断目标判据）
    private hasExplicitModes(args: Term[], ret?: Term): boolean {
        const annotated = (t: Term) => t.nameArity === '::/2' || t.nameArity === '>>/2'
        return args.some(annotated) || (!!ret && annotated(ret))
    }
    // 把一组类型里“同名的具名类型变量”合并为同一个 MerType 变量对象。
    // 否则谓词签名里同一类型参数（如 pred(V,W) 与 assoc_list(K,V) 的 V）会是不同对象，
    // 永远无法合一，推断时会被错误塌缩（例如 P 的 pred(V,W) 变成 pred(W,W)）。
    private shareTypeParams(types: MerType[]): MerType[] {
        const canon = new Map<string, MerType>()
        const collect = (t: MerType) => {
            if (t.kind === 'var') {
                if (!/^\?\d+$/.test(t.name) && !canon.has(t.name)) canon.set(t.name, t)
                return
            }
            if (t.kind === 'ctor') t.args.forEach(collect)
            if (t.kind === 'ho') { t.args.forEach(collect); if (t.result) collect(t.result) }
        }
        types.forEach(collect)
        const norm = (t: MerType): MerType => {
            if (t.kind === 'var') { const c = canon.get(t.name); return (c && c !== t) ? c : t }
            if (t.kind === 'ctor') return { ...t, args: t.args.map(norm) }
            if (t.kind === 'ho') return { ...t, args: t.args.map(norm), result: t.result ? norm(t.result) : undefined }
            return t
        }
        return types.map(norm)
    }

    private recordFuncInfo(func: Term, ret: Term | undefined, determinism?: string) {
        const argRefs = func.args.map(a => this.argModeRefOf(a))
        const retRef = ret ? this.retModeRefOf(ret) : undefined
        this.funcs.set(keyOf(func.name, func.semanticArity), {
            name: func.name, arity: func.semanticArity,
            argTypes: this.shareTypeParams(func.args.map(a => termToMerType(a))),
            argModes: argModesOf(func.args),
            resultType: ret ? this.shareTypeParams([termToMerType(ret)])[0] : undefined,
            resultMode: ret ? modeOfArg(ret) : undefined,
            argModeRefs: argRefs,
            resultModeRef: retRef,
            hasExplicitModes: this.hasExplicitModes(func.args, ret),
            // :: 注解的声明本身定义一条过程 mode；后续 :- mode f(...) 声明追加
            modes: this.hasExplicitModes(func.args, ret)
                ? [{ argModeRefs: argRefs, resultModeRef: retRef, det: determinism }]
                : [],
        })
        // 每个 mode 声明一行（Mercury 默认 mode：参数 in，函数结果 out）；带确定性后缀
        const modes = func.args.map(modeOfArg).map(m => m ?? 'in')
        const rm = ret ? modeOfArg(ret) ?? 'out' : 'out'
        const det = determinism ? ` is ${determinism}` : ''
        this.pushModeSig(keyOf(func.name, func.semanticArity), `${func.name}(${modes.join(', ')}) = (${rm})${det}`)
    }
    // 记录谓词签名（name/arity → 参数类型/mode；谓词无返回类型）
    private recordPredInfo(pred: Term, determinism?: string) {
        const argRefs = pred.args.map(a => this.argModeRefOf(a))
        this.preds.set(keyOf(pred.name, pred.semanticArity), {
            name: pred.name, arity: pred.semanticArity,
            argTypes: this.shareTypeParams(pred.args.map(a => termToMerType(a))),
            argModes: argModesOf(pred.args),
            argModeRefs: argRefs,
            hasExplicitModes: this.hasExplicitModes(pred.args),
            modes: this.hasExplicitModes(pred.args)
                ? [{ argModeRefs: argRefs, det: determinism }]
                : [],
        })
        const modes = pred.args.map(modeOfArg).map(m => m ?? 'in')
        const det = determinism ? ` is ${determinism}` : ''
        this.pushModeSig(keyOf(pred.name, pred.semanticArity), `${pred.name}(${modes.join(', ')})${det}`)
    }
    // :- mode I == Init >> Final 结构化入库（Phase A）；mode 别名 `I == Body`（Body 是单个
    // mode 引用，如 array.m 的 `:- mode array_uo == out(uniq_array).`）记 alias 引用，
    // 由 modeRefToInsts 惰性解引用（别名可能指向尚未收集的其它用户 mode）；高阶模式体
    //（pred(...)/func(...)）暂不收集
    private recordModeDef(headTerm: Term, body: Term) {
        const head = instDefHead(headTerm)
        if (!head || isVariable(body)) return
        if (body.nameArity === '>>/2') {
            this.modeDefs.set(keyOf(head.name, head.arity), {
                params: head.params,
                initial: instTermToMerInst(body.args[0]),
                final: instTermToMerInst(body.args[1]),
            })
            return
        }
        if (['pred', 'predicate', 'func', 'function'].includes(body.name)) return
        this.modeDefs.set(keyOf(head.name, head.arity), {
            params: head.params,
            initial: { kind: 'free' },
            final: { kind: 'free' },
            alias: modeTermToRef(body),
        })
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
        const arr = this.modeSigs.get(key)
        if (arr) arr.push(line)
        else this.modeSigs.set(key, [line])
    }
    // 显式 pred/func-mode 声明 → modeSigs：首个声明替换 recordPred/FuncInfo 推出的默认行
    //（Mercury：有显式 mode 声明时默认 mode 不适用），同一 pred 的后续声明追加
    private modeSigReplaced = new Set<string>()
    private pushModeSigReplacingDefault(key: string, line: string) {
        if (this.modeSigReplaced.has(key)) {
            this.pushModeSig(key, line)
            return
        }
        this.modeSigs.set(key, [line])
        this.modeSigReplaced.add(key)
    }
    // 声明参数与函数返回值共用：Type / Type :: Mode / Type >> Mode，Type 是类型引用位置
    visitTypeParams(pred: Term) {
        for (const param of pred.args ?? []) this.visitTypeParam(param)
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
    addReference(term: Term) {
        this.reference.add(term.name, term)
        this.addCalled(term)
    }
    addDeclaration(term: Term) {
        this.declaration.add(term.name, term)
        this.tryAddExport(term)
        this.addCallee(term)
    }
    addDefinition(term: Term) {
        this.definition.add(term.name, term)
        this.addCallee(term)
    }
    
    addExport(term: Term) {
        term.qualified = this.module
        this.exports.add(term.name ,term)
    }
    addImport(module: Term) {
        this.imports.push(module)
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
    tryAddExport(term:Term){
        if(this.section == "interface"){
            this.addExport(term);
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

    // ===== 阶段 2：子句级类型推断（自下而上合一，供 linker 用类型消歧 functor/func）=====
    // 设计：复用编译器同构数据流——头签名推导头变量类型，再沿 body 目标/数据项
    // 自下而上合一；重载（func+构造子同名同元数）在类型上下文能唯一确定时消歧，
    // 否则保持无类别（不标注），避免误标。推断失败不应影响索引/labeling。
    private inferClause(clause: Clause) {
        const top = clause.term
        // 声明（:-/1）与 DCG（-->/2）不做子句级推断
        if (top.nameArity === ':-/1' || top.nameArity === '-->/2') return
        if (!clause.callee) return
        this.subst = new Map()
        this.varTypes = new Map()
        this.varMode = new Map()
        this.varCounter = 0
        try {
            if (top.nameArity === ':-/2') {
                this.inferHead(top.args[0])
                this.inferGoal(top.args[1])
            } else if (top.nameArity === '=/2') {
                // 函数事实 `F(...) = Expr`：结果按返回类型推断；头参数按签名
                const sig = this.signatureOf(clause.callee)
                if (sig) {
                    this.markVarMode(top.args[1], sig.resultMode ?? 'out')
                    if (sig.resultType) this.inferTerm(top.args[1], sig.resultType)
                }
                this.inferHead(top.args[0])
            } else {
                // 谓词事实：仅头
                this.inferHead(top)
            }
        } catch {
            // 推断异常不向外抛，保持索引稳定
        }
    }
    // 变量子句级 mode 标记（只记首次；head 形参优先于后续绑定处推断）
    private markVarMode(term: Term, mode: string) {
        if (isVariable(term) || ['!/1', '!./1', '!:/1'].includes(term.nameArity)) {
            const key = this.varKey(term)
            if (!this.varMode.has(key)) this.varMode.set(key, mode)
        }
    }
    // 状态变量 !X 在解析树里只占一个参数节点，语义上却对应签名的两个字段
    //（!.X / !:X）；!.X、!:X 各占一个。按语义宽度对齐，否则 `p(A, B, C, !X, !Y)`
    // 会把 !Y 错对到第 4 个签名字段（推成 X 的类型）。
    private argWidth(term: Term): number {
        return term.nameArity === '!/1' ? 2 : 1
    }
    // 按签名字段对齐实参：!X 吃掉两个字段但只推断一次（两个字段类型相同）
    private inferSignatureArgs(args: Term[], sig: FuncInfo) {
        const argTypes = sig.argTypes.map(a => applySubst(a, this.subst))
        let ti = 0
        for (const arg of args) {
            this.markVarMode(arg, sig.argModes?.[ti] ?? 'in')
            this.inferTerm(arg, argTypes[ti])
            ti += this.argWidth(arg)
        }
    }
    // 头签名 → 头参数类型/mode（状态变量 !X / !.X / !:X 视为同一变量 X）
    private inferHead(head: Term) {
        // 带体的函数子句 `f(A1..An) = R :- Body`：头是 =(f(A1..An), R)，
        // 参数按签名推断，结果变量 R 按返回类型推断
        if (head.nameArity === '=/2') {
            const call = head.args[0]
            const sig = this.signatureOf(call)
            if (sig) {
                this.inferSignatureArgs(call.args, sig)
                this.markVarMode(head.args[1], sig.resultMode ?? 'out')
                if (sig.resultType) this.inferTerm(head.args[1], sig.resultType)
                return
            }
            // `X = Expr` 形式的头（少见）：两侧按统一推断
            this.inferUnify(head.args[0], head.args[1])
            return
        }
        const sig = this.signatureOf(head)
        if (!sig) return
        this.inferSignatureArgs(head.args, sig)
    }
    // 目标遍历（goal 位置：调用 p(args) / 统一 X = rhs）
    private inferGoal(term: Term) {
        switch (term.nameArity) {
            case '=/2':
            case '\\=/2':
                this.inferUnify(term.args[0], term.args[1])
                break
            case './2':
                this.inferGoal(this.unwrapQualifiedInfer(term))
                break
            case ',/2':
            case ';/2':
            case '&/2':
            case '->/2':
            case 'else/2':
            case 'if/3':
            case 'if/1':
            case 'then/2':
            case 'or_else/2':
            case ':-/2':
                // if-then-else 解析树为 else(if(then(C,T)), E)：if/1、then/2 必须按 goal
                // 递归，否则 then 分支会落进 default 被当数据 functor 推断，
                // 分支内 Y = X 的 Y 合一不到 X 的 head 类型而显示 unknown
                this.inferGoal(term.args[0])
                if (term.args[1]) this.inferGoal(term.args[1])
                break
            case 'some/2':
            case 'all/2':
            case 'not/1':
            case '\\+/1':
                this.inferGoal(term.args[1] ?? term.args[0])
                break
            case 'require_det/1':
            case 'require_semidet/1':
            case 'require_multi/1':
            case 'require_nondet/1':
            case 'require_cc_multi/1':
            case 'require_cc_nondet/1':
            case 'require_erroneous/1':
            case 'require_failure/1':
            case 'promise_pure/1':
            case 'promise_semipure/1':
            case 'promise_impure/1':
            case 'event/1':
                this.inferGoal(term.args[0])
                break
            case 'require_complete_switch/2':
            case 'require_switch_arms_det/2':
            case 'require_switch_arms_semidet/2':
            case 'require_switch_arms_multi/2':
            case 'require_switch_arms_nondet/2':
            case 'require_switch_arms_cc_multi/2':
            case 'require_switch_arms_cc_nondet/2':
            case 'require_switch_arms_erroneous/2':
            case 'require_switch_arms_failure/2':
            case 'disable_warnings/2':
            case 'disable_warning/2':
            case 'trace/2':
            case 'promise_equivalent_solutions/2':
            case 'promise_equivalent_solution_sets/2':
                this.inferGoal(term.args[1])
                break
            case 'true/0':
            case 'fail/0':
                break
            default:
                // 调用目标 p(args)（func 在 goal 位置极少见）
                this.inferCall(term)
        }
    }
    // 调用：按签名对齐实参类型
    private inferCall(term: Term) {
        const sig = this.signatureOf(term)
        if (!sig) {
            // 高阶变量调用：形如 (P, V0, V) 的应用节点（(f, a1, a2, ...) 中 f 是持有谓词/函数值的变量），
            // 解析树里表现为 nameArity = "(/N)" 且 args[0] 是变量。
            // 不能当普通数据 functor 推断，否则会把 P 误标成数据项、把实参 V0/V 推成 fresh 未知类型，
            // 还会用新鲜类型覆盖 P 在头里已推得的 pred(V, W)。
            if (term.nameArity.startsWith('(/') && term.args.length >= 2 && isVariable(term.args[0])) {
                const calleeTerm = term.args[0]
                const callArgs = term.args.slice(1)
                // !X 在调用里同样占两个高阶参数字段；按语义宽度算 n，否则
                // pred(int,T,A,A,B,B) 配 P(0, E, !A, !B) 会被判定元数不符，
                // 退化成全 fresh 的高阶类型并把签名里的类型变量冲成 unknown
                const widths = callArgs.map(a => this.argWidth(a))
                const n = widths.reduce((s, w) => s + w, 0)
                const calleeKey = this.varKey(calleeTerm)
                const calleeType = this.varTypes.get(calleeKey)
                const resolved = calleeType ? applySubst(calleeType, this.subst) : undefined
                let hoArgs: MerType[]
                if (resolved && resolved.kind === 'ho' && resolved.args.length === n) {
                    hoArgs = resolved.args
                } else {
                    hoArgs = Array.from({ length: n }, () => ({ kind: 'var', name: this.freshVar() } as MerType))
                    const freshHo: MerType = { kind: 'ho', pf: 'pred', args: hoArgs }
                    if (calleeType) unify(calleeType, freshHo, this.subst)
                    else { const v: MerType = { kind: 'var', name: this.freshVar() }; this.varTypes.set(calleeKey, v); unify(v, freshHo, this.subst) }
                }
                let ti = 0
                for (let i = 0; i < callArgs.length; i++) {
                    this.inferTerm(callArgs[i], hoArgs[ti])
                    ti += widths[i]
                }
                return
            }
            // 非 pred/func（未知标识符）：兜底当数据 functor，安全不抛
            this.inferFunctor(term)
            return
        }
        this.inferSignatureArgs(term.args, sig)
    }
    // 统一目标：rhs 类型需与 lhs 一致；lhs 若已有具体类型（来自头签名）则约束 rhs。
    // 首次出现在绑定位置的变量记子句级 mode out（head 形参已在 inferHead 标记，不会被覆盖）
    private inferUnify(lhs: Term, rhs: Term) {
        this.markVarMode(lhs, 'out')
        this.markVarMode(rhs, 'out')
        const lt = this.inferTerm(lhs)
        const rt = this.inferTerm(rhs, lt)
        unify(lt, rt, this.subst)
        // unify 后刷新两侧的推断条目：先推断一侧可能已写入未合一的 stale 类型
        // （如 `Y = X` 中 Y 先被记为自由变量，合一后才有 X 的具体类型）
        this.refreshVarTypes(lhs)
        this.refreshVarTypes(rhs)
    }
    // 递归刷新 term 下所有变量出现处的推断条目（按当前 varTypes + subst 重新解析）
    private refreshVarTypes(term: Term) {
        if (isVariable(term) || ['!/1', '!./1', '!:/1'].includes(term.nameArity)) {
            const key = this.varKey(term)
            const t = this.varTypes.get(key)
            if (t) {
                const resolved = applySubst(t, this.subst)
                this.pushVarType(term, resolved)
            }
            return
        }
        for (const a of term.args ?? []) this.refreshVarTypes(a)
    }
    private pushVarType(term: Term, resolved: MerType) {
        const key = this.varKey(term)
        // 状态变量外层节点（!X / !.X / !:X）不在 varMap 里，parser 只收了内层 X；
        // 以前只写外层节点，hover 落在内层 X 上就只看到后续推断覆盖出的 unknown。
        const varMap = term.clause?.varMap ?? this.currentClause?.varMap
        const occurrences = varMap?.get(key) ?? []
        const info = { type: resolved, mode: this.varMode.get(key) }
        this.inferred.set(term, info)
        for (const occ of occurrences) this.inferred.set(occ, info)
    }
    // 项/变量 → 类型（数据位置）；状态变量映射到底层变量名
    private inferTerm(term: Term, expected?: MerType): MerType {
        if (isVariable(term) || ['!/1', '!./1', '!:/1'].includes(term.nameArity)) {
            const key = this.varKey(term)
            let t = this.varTypes.get(key)
            if (!t) { t = { kind: 'var', name: this.freshVar() }; this.varTypes.set(key, t) }
            if (expected) unify(t, expected, this.subst)
            const resolved = applySubst(t, this.subst)
            this.pushVarType(term, resolved)
            return resolved
        }
        // 高阶表达式（func(...) = ... / (pred(...) is det) / 带 :- Body 的闭包）
        const ho = this.inferHigherOrder(term, expected)
        if (ho) return ho

        const st = term.syntaxType
        if (st === 'integer') { const t: MerType = { kind: 'ctor', ctor: { name: 'int', arity: 0 }, args: [] }; this.inferred.set(term, { type: t }); return t }
        if (st === 'float') { const t: MerType = { kind: 'ctor', ctor: { name: 'float', arity: 0 }, args: [] }; this.inferred.set(term, { type: t }); return t }
        if (st === 'string') { const t: MerType = { kind: 'ctor', ctor: { name: 'string', arity: 0 }, args: [] }; this.inferred.set(term, { type: t }); return t }
        // 列表语法：[]/0 与 [|]/2 恒为 list 构造子，交由 inferList（含同义词展开与构造子标注）
        if (term.nameArity === '[|]/2' || term.nameArity === '[]/0') {
            return this.inferList(term, expected)
        }
        if (term.nameArity === './2') {
            // 模块限定调用 uint.cast_to_int(Size)：解析树是 ./2(模块名, 调用)。
            // 索引遍历已解包（visitQualifiedTerm）；推断这里同样解包后对内层项推断，
            // 否则 ./2 会被当名为 `.` 的普通 functor 查不到而落 unknown
            const target = this.unwrapQualifiedInfer(term)
            const t = this.inferTerm(target, expected)
            this.inferred.set(term, { type: t })
            return t
        }
        // 一般 functor（atom 或复合项）：构造子 或 数据位置函数调用
        return this.inferFunctor(term, expected)
    }
    // 纯解包模块限定（a.b.c → c，逐层设 qualified；索引遍历已设，此处幂等），不做索引副作用
    private unwrapQualifiedInfer(term: Term): Term {
        let t = term
        while (!isVariable(t) && t.nameArity === './2') {
            const right = t.args[1]
            if (t.args[0]) right.qualified = t.args[0]
            t = right
        }
        return t
    }
    // 列表字面量：元素类型由 expected（list(E)）给定，否则新建类型变量
    private inferList(term: Term, expected?: MerType): MerType {
        let elemType: MerType = { kind: 'var', name: this.freshVar() }
        // 展开类型同义词：assoc_list(K,V) == list(pair(K,V)) → 取 list 元素类型 pair(K,V)
        if (expected) {
            const resolved = this.resolveSynonym(expected)
            if (resolved.kind === 'ctor' && resolved.ctor.name === 'list' && resolved.args.length === 1) {
                elemType = resolved.args[0]
            }
        }
        const listType = (): MerType => ({ kind: 'ctor', ctor: { name: 'list', arity: 1 }, args: [applySubst(elemType, this.subst)] })
        const walk = (t: Term) => {
            if (t.nameArity === '[]/0') {
                // 空表也是 list 的构造子
                this.inferred.set(t, { type: listType(), category: 'constructor' })
                return
            }
            if (t.nameArity === '[|]/2') {
                // [|]/2 恒为 list 的 cons 构造子（Mer 无法重定义）
                this.inferred.set(t, { type: listType(), category: 'constructor' })
                this.inferTerm(t.args[0], elemType)
                walk(t.args[1])
                return
            }
            // 可能直接是变量尾（!.List / Tail）
            this.inferTerm(t, { kind: 'ctor', ctor: { name: 'list', arity: 1 }, args: [elemType] })
        }
        walk(term)
        // 整表项（[|]/2 或 []/0）同样标为 list 构造子
        const category = (term.nameArity === '[|]/2' || term.nameArity === '[]/0') ? 'constructor' : undefined
        const result = listType()
        this.inferred.set(term, { type: result, category })
        return result
    }
    // 展开类型同义词（equivalence type，type T == U）：把 T(A,..) 还原为 U（代入类型参数）；
    // 本地 this.types 与跨模块 exportManager 都查。非同义词原样返回。
    private resolveSynonym(t: MerType): MerType {
        if (t.kind !== 'ctor') return t
        const ti = this.types.get(keyOfTypeCtor(t.ctor)) ?? this.exportManager.lookupType(keyOfTypeCtor(t.ctor))
        if (!ti || !ti.body) return t
        const subst = new Map<string, MerType>()
        for (let i = 0; i < ti.params.length; i++) {
            const p = ti.params[i]
            if (p.kind === 'var' && t.args[i]) subst.set(p.name, t.args[i])
        }
        return applySubst(ti.body, subst)
    }
    // 数据位置 functor：用 expected 类型与签名消歧 构造子/函数；重载且类型无法唯一确定时保持无类别
    private inferFunctor(term: Term, expected?: MerType): MerType {
        const name = term.name
        const arity = term.arity
        const expCtor = expected && expected.kind === 'ctor' ? expected.ctor : undefined
        const constrs: ConsInfo[] = []
        const collectConstrs = (ti: TypeInfo) => {
            for (const ci of ti.constructors) {
                if (ci.ctor === name && ci.arity === arity) constrs.push(ci)
            }
        }
        for (const ti of this.types.values()) collectConstrs(ti)
        // 跨模块：类型上下文明确时，纳入导入模块里同名同元数的类型构造子
        if (expCtor) {
            for (const ti of this.exportManager.allTypeInfos()) {
                if (ti.ctor.name === expCtor.name && ti.ctor.arity === expCtor.arity) collectConstrs(ti)
            }
        }
        const localFunc = this.funcs.get(keyOf(name, arity))
        // 限定名 M.f(...)：按限定模块精确查签名（钉死模块，无重载歧义）
        const qualFunc = term.qualified
            ? this.moduleManager.get(term.qualified)?.visitResult?.funcs.get(keyOf(name, arity))
            : undefined
        const crossFunc = qualFunc ?? this.exportManager.lookupFunc(name, arity)

        let chosenCI: ConsInfo | undefined
        let chosenFunc: FuncInfo | undefined
        if (qualFunc) {
            // 限定调用直接消解为该模块的 func/签名（不受「类型未知不引入跨模块候选」限制）
            chosenFunc = qualFunc
        } else if (expCtor) {
            // 类型上下文明确：取首个能合一的构造子；否则若 func 结果类型能合一则取 func
            // （跨模块 func 仅在类型上下文明确时参与，避免把无类型上下文的重载项误标）
            const matches = constrs.filter(ci => unify(ci.resultType, expected!, this.subst))
            if (matches.length >= 1) {
                chosenCI = matches[0]
            } else if (localFunc ?? crossFunc) {
                chosenFunc = localFunc ?? crossFunc
            }
        } else {
            // 类型未知：仅用本模块符号消歧；跨模块候选不引入（否则会把本应无类别的重载项误标）
            if (localFunc && constrs.length === 0) {
                chosenFunc = localFunc
            } else if (!localFunc && constrs.length === 1) {
                chosenCI = constrs[0]
            } else if (localFunc && constrs.length >= 1 && localFunc.argTypes.length === arity) {
                chosenFunc = localFunc
            }
            // 其余（多构造子无 func、func+构造子但参数元数不符、跨模块仅 func）无法消歧 → 留无类别
        }

        let resultType: MerType
        let category: 'constructor' | 'func' | undefined
        if (chosenCI) {
            resultType = applySubst(chosenCI.resultType, this.subst)
            category = 'constructor'
        } else if (chosenFunc) {
            resultType = chosenFunc.resultType ?? { kind: 'var', name: this.freshVar() }
            category = 'func'
        } else {
            resultType = { kind: 'var', name: this.freshVar() }
        }

        // 对齐参数类型
        const argTypes = chosenCI ? chosenCI.argTypes.map(a => applySubst(a, this.subst))
            : chosenFunc ? chosenFunc.argTypes.map(a => applySubst(a, this.subst))
            : term.args.map(() => ({ kind: 'var', name: this.freshVar() } as MerType))
        for (let i = 0; i < term.args.length; i++) {
            this.inferTerm(term.args[i], argTypes[i])
        }
        this.inferred.set(term, { type: resultType, category })
        return resultType
    }
    // 高阶表达式：func(Head) = Result | (pred(Head) is Det) | 带 :- Body 的闭包。
    // 用 expected 的 ho 签名给闭包头绑定变量赋类型，并递归推断闭包头/体。
    private inferHigherOrder(term: Term, expected?: MerType): MerType | undefined {
        let pf: 'pred' | 'func' | undefined
        let headTerm: Term | undefined
        let resultTerm: Term | undefined
        let bodyTerm: Term | undefined
        const a0 = term.args[0]
        if (term.nameArity === '=/2' && a0 && ['func', 'function'].includes(a0.name)) {
            pf = 'func'; headTerm = a0; resultTerm = term.args[1]
        } else if (term.nameArity === 'is/2' && a0 && ['pred', 'predicate'].includes(a0.name)) {
            pf = 'pred'; headTerm = a0
        } else if (term.nameArity === ':-/2') {
            const lhs = term.args[0]
            const la0 = lhs?.args[0]
            if (lhs?.nameArity === 'is/2' && la0 && ['pred', 'predicate'].includes(la0.name)) {
                pf = 'pred'; headTerm = la0; bodyTerm = term.args[1]
            } else if (lhs?.nameArity === '=/2' && la0 && ['func', 'function'].includes(la0.name)) {
                pf = 'func'; headTerm = la0; resultTerm = la0.args[1]; bodyTerm = term.args[1]
            }
        }
        if (!pf || !headTerm) return undefined

        // 闭包头绑定变量（剥离 ::/>> 模式注解），按 expected 的 ho 签名赋类型
        const headVars = headTerm.args.map(v => this.hoHeadVar(v))
        const argTypes = headVars.map(v => {
            const key = this.varKey(v)
            let t = this.varTypes.get(key)
            if (!t) { t = { kind: 'var', name: this.freshVar() }; this.varTypes.set(key, t) }
            return t
        })
        const resultType: MerType = { kind: 'var', name: this.freshVar() }
        if (expected && expected.kind === 'ho') {
            const ea = expected.args
            for (let i = 0; i < argTypes.length && i < ea.length; i++) {
                unify(argTypes[i], ea[i], this.subst)
            }
            if (expected.result) unify(resultType, expected.result, this.subst)
        }
        const hoType: MerType = { kind: 'ho', pf, args: argTypes, result: pf === 'func' ? resultType : undefined }
        if (resultTerm) this.inferTerm(resultTerm, resultType)
        if (bodyTerm) this.inferGoal(bodyTerm)
        this.inferred.set(term, { type: hoType })
        return hoType
    }
    private hoHeadVar(argTerm: Term): Term {
        if (['::/2', '>>/2'].includes(argTerm.nameArity)) return argTerm.args[0]
        return argTerm
    }
    private signatureOf(termOrName: Term | string, arity?: number): FuncInfo | undefined {
        const name = typeof termOrName === 'string' ? termOrName : termOrName.name
        const a = typeof termOrName === 'string' ? arity! : termOrName.semanticArity
        // 状态变量 !X 在语义元数上按两个参数（!.X / !:X）计，但声明处常按单个逻辑参数计（如
        // `:- pred p(list(T)::out)` 配 `p(!List)`）。两种元数都查一次，兼容这种写法。
        const aAlt = typeof termOrName === 'string' ? a : termOrName.arity
        if (typeof termOrName !== 'string' && termOrName.qualified) {
            const doc = this.moduleManager.get(termOrName.qualified)
            const sig = doc?.visitResult?.funcs.get(keyOf(name, a)) ?? doc?.visitResult?.funcs.get(keyOf(name, aAlt))
                ?? doc?.visitResult?.preds.get(keyOf(name, a)) ?? doc?.visitResult?.preds.get(keyOf(name, aAlt))
            if (sig) return sig
        }
        return this.funcs.get(keyOf(name, a)) ?? this.funcs.get(keyOf(name, aAlt))
            ?? this.preds.get(keyOf(name, a)) ?? this.preds.get(keyOf(name, aAlt))
            ?? this.exportManager.lookupFunc(name, a) ?? this.exportManager.lookupFunc(name, aAlt)
    }
    private varKey(term: Term): string {
        if (['!/1', '!./1', '!:/1'].includes(term.nameArity)) {
            return term.args[0]?.name ?? term.name
        }
        return term.name
    }
    private freshVar(): string {
        return '?' + (this.varCounter++)
    }

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
function isSpecialDataTerm(term: Term):boolean {
    return (isConditionalExpr(term)
        || isRecordSyntexExpr(term)
        || isUnificationExpr(term)
        || isLambdaExpr(term)
        || isHigerOrderFuncApplication(term)
        || isExplicitTypeQualification(term))??false
}

function isConditionalExpr(term: Term) {
    if (["else/2",";/2","->/2","if/3"].includes(term.nameArity)){
        label(term,"conditional")
        return true;
    }
}

function isRecordSyntexExpr(term: Term) {
    if( ["^/2",":=/2","=^/2"].includes(term.nameArity)){
        label(term,"record")
        return true
    }
}

function isUnificationExpr(term: Term) {
    if(term.nameArity === "@/2"){
        label(term,"unification")
        return true
    }
}
function isHigerOrderFuncApplication(term: Term) {
    if (term.name === "apply" && term.arity>0){
        label(term,"apply")
        return true
    }
}

function isExplicitTypeQualification(term: Term){
    if([":/2","with_type/2"].includes(term.nameArity)){
        label(term, "explicitType")
        return true
    }
}

function isLambdaExpr(term: Term) {
    if( [":-/2","-->/2"].includes(term.nameArity)){
        label (term,"lambda")
        return true
    }
}

export type SemanticType =
    "func"|
    "pred"|
    "type"|
    "constructor"|
    "fieldname"|
    "inst"|
    "mode"|
    "module"|
    "variable"|
    "float"|
    "integer"|
    "string"|
    "typeclass"|
    "instance"|
    "pragma"|
    "mutable"|
    "determinism"|
    "operator"|
    "implementationDefined"|
    SpecialDataTerm
export type SpecialDataTerm = 
    'conditional'|
    "record"|
    "apply"|
    "lambda"|
    "unification"|
    "explicitType"
    