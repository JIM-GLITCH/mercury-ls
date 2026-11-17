import { CancellationToken, Diagnostic, DiagnosticSeverity } from 'vscode-languageserver'
import { MercuryDocument } from './document-manager'
import { MultiMap } from './multimap'
import { TreeStreamImpl, stream } from './stream'
import { Clause, RootNode, Term, prependModuleQualifier } from './term'
import { sameArity } from './utils'
import { interruptAndCheck } from './promise-util'
import { ExportManager, ModuleManager, moduleQualifiedName } from './document-moduleManager'
import type { MercuryServices } from './services'
import {
    ConsInfo, FuncInfo, InferredInfo, LType, MerType, TypeCtor, TypeInfo,
    keyOf, keyOfTypeCtor, modeOfArg, argModesOf, termToMerType, typeHeadParts, sigCandidates,
} from './document-type'
import {
    createLogicalVar, createTrail, derefTerm, freeze, isUnboundLogicalVar, resolve, undo, unify,
    type LogicVar, type Trail,
} from './logical-var'
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
    module?: Term
    errors: Diagnostic[]
    definition: MultiMap<string, Term>,
    reference: MultiMap<string, Term>,
    typeReference: MultiMap<string, Term>,
    instReference: MultiMap<string, Term>,
    modeReference: MultiMap<string, Term>,
    // 定义表：实现子句头（addDefinition）与 interface/decl 声明项（addDeclaration，
    // term.isDeclaration=true）合并在一张表，key=name（不含 arity）；
    // 查询方按 sameArity/semanticType/isDeclaration 过滤
    exports: MultiMap<string, Term>
    // import/include/use 的模块点分名（'io.stream_ops'）；include_module 的
    // 相对名已在 visit 侧补成绝对名。需要源码位置时从 reference 索引找模块项
    imports: string[]
    // 类型推断基础数据（阶段 0+1 收集，尚未用于 link 消歧）
    types: Map<string, TypeInfo[]>        // 类型名 → 定义候选（同 name 不同 arity/限定模块共存）
    // 同名的全部签名声明（func/pred 同命名空间；key 为裸 name，元数在
    // FuncInfo.arity 上过滤，查询走 sigCandidates 的 sem→alt 遮蔽语义）
    sigAlts: Map<string, FuncInfo[]>
    // name/arity → mode 声明展示串（每个声明一行，如 add(in, in) = (out)；未注解用默认 in/out）
    modeSigs: Map<string, string[]>
    // Phase A：:- inst / :- mode 声明的结构化表示（mode 分析用）
    instDefs: Map<string, InstDef>
    modeDefs: Map<string, ModeDef>
    // 阶段 2 推断结果：项 → 推断类型/类别（供 linker 精确消歧 functor/func）
    inferred: Map<Term, InferredInfo>
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
    module?: Term
    imports = [] as string[]
    section?: string
    currentClause!: Clause
    errors: Diagnostic[] = []
    definition = new MultiMap<string, Term>()
    reference = new MultiMap<string, Term>()
    typeReference = new MultiMap<string, Term>()
    instReference = new MultiMap<string, Term>()
    modeReference = new MultiMap<string, Term>()
    exports = new MultiMap<string, Term>()
    types = new Map<string, TypeInfo[]>()
    // types 每次 addTypeInfo 递增；consIndex 是它的惰性物化（构造子名 →
    // ConsInfo），inferFunctor 查构造子候选时避免每个 functor 全表扫类型
    private typesVersion = 0
    private consIndex?: { v: number; map: Map<string, ConsInfo[]> }
    sigAlts = new Map<string, FuncInfo[]>()
    modeSigs = new Map<string, string[]>()
    instDefs = new Map<string, InstDef>()
    modeDefs = new Map<string, ModeDef>()
    inferred = new Map<Term, InferredInfo>()
    // 正在收集的类型定义（visitTypeConstrutor 往里追加构造子）
    private currentType?: TypeInfo
    // 类型推断工作态（每个子句重置）：varTypes 的值是活逻辑项 LType，
    // 变量绑定/回滚走 trail（试解失败 undo 即还原，零克隆）；varNames 记录
    // 每个逻辑变量的显示名（?N = 推断 fresh 变量 → hover 显示 unknown；
    // T#n = 声明类型变量的本次实例 → merTypeToString 剥 #n 显示 T）
    private trail: Trail = []
    private varTypes = new Map<string, LType>()
    private varNames = new WeakMap<LogicVar, string>()
    // 变量子句级 mode 近似（head 形参声明 mode / 绑定变量 out / 调用 in 实参；类型推断步骤填充，供 hover 显示）
    private varMode = new Map<string, string>()
    private varCounter = 0
    // freeze 式延迟约束：消歧失败（信息不足）的 functor 项把重试 goal 经
    // freeze/2 挂到消歧依赖的活逻辑变量上（结果类型变量 + 直接变量实参的
    // 类型变量），变量绑定到具体值时同步唤醒——等价于 Mercury freeze/2。
    // LS 容错语义：goal 恒返回 true（不回滚外层绑定），内部自行判定
    // 「信息够了就重试消歧，还不够就继续等其它变量绑定」
    // 推迟写入的推断结果：推断期间只记活逻辑项（ltype），子句末统一
    // solidify 成 MerType 落 inferred——绑定此时已全部落定
    private pendingInferred = new Map<Term, {
        ltype: LType
        category?: 'constructor' | 'func'
        sig?: FuncInfo
        mode?: string
    }>()
    // 同一 Term 只挂一次冻结（frozen goal 重试/嵌套推断会重复走到，
    // 无去重会无限堆积）
    private frozenTerms = new Set<Term>()
    // 推断开关：批量索引阶段可关闭子句级类型推断（inferred 仅供打开中文档的
    // hover/definition/linker 消歧消费，未打开文档跳过可显著降低全库 analyzing 耗时）
    private inferEnabled = true
    async visit(doc: MercuryDocument, cancelToken: CancellationToken, infer = true) {
        this.errors = []
        this.inferEnabled = infer
        let rootNode = doc.parseResult.value
        for (const clause of rootNode.args) {
            await interruptAndCheck(cancelToken)
            this.visitClause(clause)
        }
        doc.visitResult = {
            module: this.module,
            errors: this.errors,
            definition: this.definition,
            reference: this.reference,
            typeReference: this.typeReference,
            instReference: this.instReference,
            modeReference: this.modeReference,
            exports: this.exports,
            imports: this.imports,
            types: this.types,
            sigAlts: this.sigAlts,
            modeSigs: this.modeSigs,
            instDefs: this.instDefs,
            modeDefs: this.modeDefs,
            inferred: this.inferred
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
        if (this.inferEnabled) this.inferClause(clause)
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
        // 限定定义头 `m.p(X) :- ...` 是 ./2 节点：解包后索引，否则 definition['.']
        const head = this.visitQualifiedTerm(term) ?? term
        label(head, "pred")
        this.addDefinition(head)
        this.currentClause.callee = head
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
        const head = this.visitFuncDef(func)
        // 定义子句 `F(...) = 表达式` 的右侧是函数体/结果表达式，不是返回类型；
        // 按数据项访问（functor 或数据构造子由 linker 阶段区分），避免误标成 type
        this.visitDataTerm(funcResult)
        this.currentClause.callee = head
    }
    visitFuncDef(func: Term) {
        // 限定定义头 `m.f(X) = ...` 是 ./2 节点：必须解包后再索引，
        // 否则 definition 以 '.' 为键、callee 也拿不到 functor 项
        const head = this.visitQualifiedTerm(func) ?? func
        label(head, "func")
        this.addDefinition(head)
        return head
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

        const right = this.visitQualifiedTerm(term)
        label(right, "type")
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
            info.body = this.toMerType(term.args[1])
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
        else {
            // Abstract types
            this.visitTypeDeclType(term)

        }
    }
    visitTypeDeclType(term: Term) {
        const right = this.visitQualifiedTerm(term)
        label(right, "type")
        this.addDefinition(right)
        this.tryAddExport(right)
        this.addTypeInfo(this.beginTypeInfo(term))
    }
    // 开始收集一个类型定义，返回 TypeInfo（构造子通过 currentType 追加）
    private beginTypeInfo(typeHead: Term): TypeInfo {
        // 类型名可能是限定名（io.error 的 ./2 链）：typeHeadParts 还原点分名
        // 与限定符，否则 ctor 会记成 '. '/2、参数错把限定符当类型参数。
        // module 取限定符（显式限定声明），否则取当前模块名——同一模块里的
        // 类型在导出索引里以 module.name/arity 登记，消除跨模块同名冲突
        const parts = typeHeadParts(typeHead)
        const tc: TypeCtor = {
            name: parts.name, arity: parts.arity,
            module: parts.qualifier ?? this.localModuleName(),
        }
        const info: TypeInfo = { ctor: tc, params: parts.args.map(a => this.toMerType(a)), constructors: [] }
        this.currentType = info
        return info
    }
    private endTypeInfo(info: TypeInfo) {
        this.addTypeInfo(info)
        this.currentType = undefined
    }
    // 本模块点分名（module a.b. → 'a.b'）；无 module 声明时 undefined
    private localModuleName(): string | undefined {
        return this.module ? moduleQualifiedName(this.module) : undefined
    }
    private addTypeInfo(info: TypeInfo) {
        this.typesVersion++
        // 本模块表按裸 name 存候选（同 name 不同 arity/限定模块共存，查询时
        // 按 ctor.arity/module 过滤）；同一 qualified 类型重复声明
        //（interface/implementation 双写）后者覆盖，保持旧单值 Map 的语义
        const k = keyOfTypeCtor(info.ctor)
        const arr = this.types.get(info.ctor.name)
        if (arr) {
            const i = arr.findIndex(ti => keyOfTypeCtor(ti.ctor) === k)
            if (i >= 0) arr[i] = info
            else arr.push(info)
        } else {
            this.types.set(info.ctor.name, [info])
        }
    }
    // Term → MerType 并补齐 ctor.module：termToMerType 只解出显式限定符，
    // 未限定引用在这里按「本模块声明优先 → 全局导出索引唯一命中」解析
    private toMerType(term: Term): MerType {
        return this.resolveMerModules(termToMerType(term))
    }
    private resolveMerModules(t: MerType): MerType {
        if (t.kind === 'var') return t
        if (t.kind === 'ho') {
            return {
                ...t,
                args: t.args.map(a => this.resolveMerModules(a)),
                result: t.result ? this.resolveMerModules(t.result) : undefined,
            }
        }
        const ctor = t.ctor.module ? t.ctor : { ...t.ctor, module: this.typeModuleOf(t.ctor) }
        return { kind: 'ctor', ctor, args: t.args.map(a => this.resolveMerModules(a)) }
    }
    // 未限定类型引用 → 定义模块名：本模块已声明的优先（遮蔽导入），
    // 否则查全局导出索引；跨模块同名歧义或 builtin 时返回 undefined
    private typeModuleOf(ctor: TypeCtor): string | undefined {
        // 正在声明的类型自身（递归引用如 node(T, tree(T))）：尚未入 this.types
        const ct = this.currentType
        if (ct && ct.ctor.name === ctor.name && ct.ctor.arity === ctor.arity) {
            return ct.ctor.module ?? this.localModuleName()
        }
        const cands = this.types.get(ctor.name)?.filter(ti => ti.ctor.arity === ctor.arity) ?? []
        const local = cands.find(ti => ti.ctor.module === this.localModuleName()) ?? cands.at(-1)
        if (local) return local.ctor.module ?? this.localModuleName()
        return this.exportManager.lookupType(ctor)?.ctor.module
    }
    // 本模块类型查询：限定名只匹配同模块声明（ctor.module 与本模块名一致），
    // 未限定名按 name/arity 命中本模块表；同 name+arity 多个限定声明时
    // 优先本模块模块名，其次取最后声明
    private localTypeInfo(ctor: TypeCtor): TypeInfo | undefined {
        const cands = this.types.get(ctor.name)?.filter(ti => ti.ctor.arity === ctor.arity) ?? []
        const compat = ctor.module
            ? cands.filter(ti => !ti.ctor.module || ti.ctor.module === ctor.module)
            : cands
        if (!compat.length) return undefined
        return compat.find(ti => ti.ctor.module === this.localModuleName()) ?? compat.at(-1)
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
                argTypes: term.args.map(a => this.toMerType(a)),
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
            // include_module 声明的是当前模块的子模块，名字可免全限定
            //（Mercury 语义：module io 里的 stream_ops = io.stream_ops）。
            // 统一补成绝对限定名再入索引，否则 moduleManager.get('stream_ops')
            // 永远找不到注册名 'io.stream_ops'；已带本模块前缀的写法跳过
            if (this.module) {
                const cur = moduleQualifiedName(this.module)
                const written = moduleQualifiedName(module)
                if (written !== cur && !written.startsWith(cur + '.')) {
                    prependModuleQualifier(module, this.module)
                }
            }
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
        if (!this.module) {
            this.module = module
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
            let module = this.visitQualifiedModule(left)
            // .qualified 统一为点分前缀字符串（'io.stream_ops'），不存 Term 链；
            // left 可能是 './2' 原始链，moduleQualifiedName 对两种形态都正确
            right.qualified = moduleQualifiedName(left)
            label(module, "module")
            this.addReference(left)
            return right
        }
        return term
    }
    visitQualifiedModule(term: Term) {
        if (nameArity(term, "./2")) {
            let [left, right] = term.args
            right.qualified = moduleQualifiedName(left)
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
        // 类名同样可能是限定名（typeclass mod.foo）：解包 ./2 再索引
        const unwrappedClass = this.visitQualifiedTerm(classTerm) ?? classTerm
        label(unwrappedClass, "typeclass")
        this.addDefinition(unwrappedClass)
        this.tryAddExport(unwrappedClass)
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
        // 实例头可以是限定名（instance stream.writer(...)）：先解包 ./2，
        // 否则 ./2 节点本身被当定义名收进索引（definition['.'] / './2'）
        const unwrapped = this.visitQualifiedTerm(head) ?? head
        label(unwrapped, "instance")
        this.addDefinition(unwrapped)
        // 实例化的类型参数是类型引用位置（类型变量除外）
        for (const arg of unwrapped.args ?? []) {
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
            if (head.semanticArity > 0 && !isVariable(head) &&
                this.sigAlts.get(head.name)?.some(f => f.arity === head.semanticArity)) {
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
        this.addDefinition(term)
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
        for (const fi of this.sigAlts.get(head.name)?.filter(
            f => f.kind === 'pred' && f.arity === head.semanticArity) ?? []) {
            fi.modes = fi.modes ?? []
            fi.modes.push({ argModeRefs: refs, det: determinism })
            if (!fi.hasExplicitModes && fi.modes.length === 1) fi.argModeRefs = refs
        }
        const det = determinism ? ` is ${determinism}` : ''
        this.pushModeSigReplacingDefault(
            key, `${this.qualDisplayName(head.name)}(${head.args.map(a => this.modeArgToString(a)).join(', ')})${det}`)
    }
    // func-mode 声明 `:- mode f(Modes) = (Mode) [is Det].`
    visitFuncMode(term: Term, determinism?: string) {
        const headTerm = this.visitQualifiedTerm(term.args[0]) ?? term.args[0]
        const head = headTerm
        label(head, "func")
        const key = keyOf(head.name, head.semanticArity)
        const refs = head.args.map(modeTermToRef)
        const retRef = modeTermToRef(term.args[1])
        for (const fi of this.sigAlts.get(head.name)?.filter(
            f => f.kind === 'func' && f.arity === head.semanticArity) ?? []) {
            fi.modes = fi.modes ?? []
            fi.modes.push({ argModeRefs: refs, resultModeRef: retRef, det: determinism })
            if (!fi.hasExplicitModes && fi.modes.length === 1) {
                fi.argModeRefs = refs
                fi.resultModeRef = retRef
            }
        }
        const det = determinism ? ` is ${determinism}` : ''
        this.pushModeSigReplacingDefault(
            key, `${this.qualDisplayName(head.name)}(${head.args.map(a => this.modeArgToString(a)).join(', ')})` +
        ` = (${this.modeArgToString(term.args[1])})${det}`)
    }
    // 签名/mode 行的限定显示名：module.name（无 module 声明时裸名）
    private qualDisplayName(name: string, module?: string): string {
        const m = module ?? this.localModuleName()
        return m ? `${m}.${name}` : name
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
        if (head) this.instDefs.set(keyOf(head.name, head.arity), { params: head.params, body })
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
        this.addDefinition(term)
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
        const info: FuncInfo = {
            kind: 'func',
            name: func.name, arity: func.semanticArity, module: this.localModuleName(),
            argTypes: this.shareTypeParams(func.args.map(a => this.toMerType(a))),
            argModes: argModesOf(func.args),
            resultType: ret ? this.shareTypeParams([this.toMerType(ret)])[0] : undefined,
            resultMode: ret ? modeOfArg(ret) : undefined,
            argModeRefs: argRefs,
            resultModeRef: retRef,
            hasExplicitModes: this.hasExplicitModes(func.args, ret),
            // :: 注解的声明本身定义一条过程 mode；后续 :- mode f(...) 声明追加
            modes: this.hasExplicitModes(func.args, ret)
                ? [{ argModeRefs: argRefs, resultModeRef: retRef, det: determinism }]
                : [],
        }
        this.pushAlt(this.sigAlts, func.name, info)
        // 每个 mode 声明一行（Mercury 默认 mode：参数 in，函数结果 out）；带确定性后缀
        const modes = func.args.map(modeOfArg).map(m => m ?? 'in')
        const rm = ret ? modeOfArg(ret) ?? 'out' : 'out'
        const det = determinism ? ` is ${determinism}` : ''
        this.pushModeSig(keyOf(func.name, func.semanticArity), `${this.qualDisplayName(func.name)}(${modes.join(', ')}) = (${rm})${det}`)
    }
    // 记录谓词签名（name/arity → 参数类型/mode；谓词无返回类型）
    private recordPredInfo(pred: Term, determinism?: string) {
        const argRefs = pred.args.map(a => this.argModeRefOf(a))
        const info: FuncInfo = {
            kind: 'pred',
            name: pred.name, arity: pred.semanticArity, module: this.localModuleName(),
            argTypes: this.shareTypeParams(pred.args.map(a => this.toMerType(a))),
            argModes: argModesOf(pred.args),
            argModeRefs: argRefs,
            hasExplicitModes: this.hasExplicitModes(pred.args),
            modes: this.hasExplicitModes(pred.args)
                ? [{ argModeRefs: argRefs, det: determinism }]
                : [],
        }
        this.pushAlt(this.sigAlts, pred.name, info)
        const modes = pred.args.map(modeOfArg).map(m => m ?? 'in')
        const det = determinism ? ` is ${determinism}` : ''
        this.pushModeSig(keyOf(pred.name, pred.semanticArity), `${this.qualDisplayName(pred.name)}(${modes.join(', ')})${det}`)
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
        term.isDeclaration = true
        this.definition.add(term.name, term)
        this.tryAddExport(term)
        this.addCallee(term)
    }
    addDefinition(term: Term) {
        this.definition.add(term.name, term)
        this.addCallee(term)
    }

    addExport(term: Term) {
        term.qualified = this.module ? moduleQualifiedName(this.module) : undefined
        this.exports.add(term.name, term)
    }
    addImport(module: Term) {
        this.imports.push(moduleQualifiedName(module))
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
        if (this.section == "interface") {
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
        this.trail = createTrail()
        this.varTypes = new Map()
        this.varNames = new WeakMap()
        this.varMode = new Map()
        this.varCounter = 0
        this.frozenTerms = new Set()
        this.pendingInferred = new Map()
        try {
            if (top.nameArity === ':-/2') {
                this.inferHead(top.args[0])
                this.inferGoal(top.args[1])
            } else if (top.nameArity === '=/2') {
                // 函数事实 `F(...) = Expr`：交给 inferHead 的 =/2 分支统一处理——
                // 调用实参与返回值必须在同一个实例化签名下推断，否则
                // `func f(T) = list(T)` 里 X 与结果的 T 会断开
                this.inferHead(top)
            } else {
                // 谓词事实：仅头
                this.inferHead(top)
            }
        } catch {
            // 推断异常不向外抛，保持索引稳定
        }
        // 子句末统一 resolve 落 inferred：此时绑定已全部落定（含 frozen
        // goal 重试的结果），活逻辑项一次展开成 MerType 快照。
        // 与推断主体同样不向外抛——固化失败只丢该子句的推断结果
        try {
            for (const [term, p] of this.pendingInferred) {
                this.inferred.set(term, {
                    type: this.solidify(p.ltype),
                    category: p.category,
                    sig: p.sig,
                    mode: p.mode,
                    ltype: p.ltype,
                })
            }
        } catch {
            // 推断异常不向外抛，保持索引稳定
        }
        this.pendingInferred.clear()
    }
    // ===== LType 基础设施 =====
    // 推断期类型项 = Logical<MerType>：签名/构造子/类型体等 MerType 模板每个
    // 使用点 instantiate 成一组逻辑变量；变量绑定记入 trail，试解失败 undo
    // 即整体还原（替代旧 subst 克隆试合一）。inferred.type 仍是写入时刻的
    // MerType 快照，推迟到子句末统一 resolve 是后续步骤的事。
    private freshLogical(name?: string): LogicVar<MerType> {
        const v = createLogicalVar<MerType>()
        this.varNames.set(v, name ?? this.freshVar())
        return v
    }
    // 变量显示名：取链尾变量查 varNames（?N → unknown；T#n → T）
    private varNameOf(v: LogicVar): string {
        return this.varNames.get(derefTerm(v) as LogicVar) ?? this.freshVar()
    }
    // MerType 模板 → LType：env 把模板类型变量名映射到既有逻辑项（resolveSynonym
    // 代入调用点实参用）；缺省时每个变量 freshLogical。声明变量带 #n 唯一名——
    // 不同实例化互不撞名（显示名/冻结唤醒都唯一），unifyTypes 的 fresh/具名
    // 偏好判定也靠它区分 ?N 与 T#n
    private instantiate(t: MerType, env: Map<string, LType> = new Map()): LType {
        const go = (x: MerType): LType => {
            if (x.kind === 'var') {
                let v = env.get(x.name)
                if (!v) {
                    v = this.freshLogical(`${x.name}#${this.varCounter++}`)
                    env.set(x.name, v)
                }
                return v
            }
            if (x.kind === 'ctor') {
                return { kind: 'ctor', ctor: x.ctor, args: x.args.map(go) } as LType
            }
            return {
                kind: 'ho', pf: x.pf, args: x.args.map(go),
                // ho 恒带 result（pred 用自由变量占位），保证两侧结构形状一致
                result: x.result ? go(x.result) : this.freshLogical(),
            } as LType
        }
        return go(t)
    }
    private instantiateSignature(sig: FuncInfo) {
        const env = new Map<string, LType>()
        return {
            sig,
            args: sig.argTypes.map(a => this.instantiate(a, env)),
            result: sig.resultType ? this.instantiate(sig.resultType, env) : undefined,
        }
    }
    private instantiateCons(ci: ConsInfo) {
        const env = new Map<string, LType>()
        return {
            ci,
            args: ci.argTypes.map(a => this.instantiate(a, env)),
            result: this.instantiate(ci.resultType, env),
        }
    }
    // derefTerm 后的当前形态：自由变量返回 undefined（无结构信息可用），
    // 否则返回 MerType 节点（节点内部 args/result 位置仍是活 LType）
    private concreteNode(t: LType | undefined): MerType | undefined {
        if (t === undefined) return undefined
        const d = derefTerm(t)
        if (isUnboundLogicalVar(d as object)) return undefined
        const n = d as MerType
        return n.kind === 'var' ? undefined : n
    }
    // 「已知类型」判定：能解出具体结构才算 known（参与消歧打分/预检）
    private isKnownType(t: LType | undefined): boolean {
        return this.concreteNode(t) !== undefined
    }
    // LType 合一：事务性——失败把本次产生的绑定整体 undo 回 trail mark。
    // 自由变量相遇时 fresh（?N）链到具名（T#n），否则 hover 上声明类型变量
    // 会被推断变量冲成 unknown（沿用旧 subst 的绑定方向偏好）
    private unifyTypes(a: LType, b: LType): boolean {
        const mark = this.trail.length
        const ok = this.unifyTypesGo(a, b)
        if (!ok) undo(this.trail, mark)
        return ok
    }
    private unifyTypesGo(a: LType, b: LType): boolean {
        const da = derefTerm(a), db = derefTerm(b)
        const aVar = isUnboundLogicalVar(da as object)
        const bVar = isUnboundLogicalVar(db as object)
        if (aVar || bVar) {
            let x: LType = a, y: LType = b
            if (aVar && bVar) {
                const fresh = (n: string) => /^\?\d+$/.test(n)
                if (!fresh(this.varNameOf(da as LogicVar)) && fresh(this.varNameOf(db as LogicVar))) {
                    x = b; y = a
                }
            }
            return unify(x, y, this.trail, true)
        }
        return this.unifyNodes(da as MerType, db as MerType)
    }
    // 两侧都已是具体节点：按 MerType 语义递归合一——ctor 要求 name/arity
    // 相同且 module 两侧都有值时才判等（缺省侧通配）；ho 要求 pf 相同，
    // result 只在两侧都存在时合一（与旧 unify 的宽松语义一致）
    private unifyNodes(a: MerType, b: MerType): boolean {
        if (a === b) return true
        if (a.kind !== b.kind) return false
        const aa = a as unknown as { ctor?: TypeCtor; pf?: string; args: LType[]; result?: LType }
        const bb = b as unknown as { ctor?: TypeCtor; pf?: string; args: LType[]; result?: LType }
        if (a.kind === 'ctor') {
            const ca = aa.ctor!, cb = bb.ctor!
            if (ca.name !== cb.name || ca.arity !== cb.arity) return false
            if (ca.module && cb.module && ca.module !== cb.module) return false
        } else if (a.kind === 'ho') {
            if (aa.pf !== bb.pf) return false
        } else {
            // 防御：模板里的 {kind:'var'} 不应进入推断（instantiate 已转逻辑变量）
            return (a as { name: string }).name === (b as { name: string }).name
        }
        if (aa.args.length !== bb.args.length) return false
        for (let i = 0; i < aa.args.length; i++) {
            if (!this.unifyTypes(aa.args[i], bb.args[i])) return false
        }
        if (aa.result && bb.result && !this.unifyTypes(aa.result, bb.result)) return false
        return true
    }
    // LType → MerType 快照（写 inferred/hover）：自由变量按链尾显示名还原
    //（?N 由 merTypeToString 显示为 unknown；T#n 剥后缀显示 T）
    private solidify(t: LType): MerType {
        return resolve<MerType>(t, (v) => ({ kind: 'var', name: this.varNameOf(v) }))
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
    private inferSignatureArgs(args: Term[], inst: { sig: FuncInfo; args: LType[]; result?: LType }) {
        let ti = 0
        for (const arg of args) {
            this.markVarMode(arg, inst.sig.argModes?.[ti] ?? 'in')
            this.inferTerm(arg, inst.args[ti])
            ti += this.argWidth(arg)
        }
    }
    // 头签名 → 头参数类型/mode（状态变量 !X / !.X / !:X 视为同一变量 X）
    private inferHead(head: Term) {
        // 带体的函数子句 `f(A1..An) = R :- Body`：头是 =(f(A1..An), R)，
        // 参数按签名推断，结果变量 R 按返回类型推断
        if (head.nameArity === '=/2') {
            const call = head.args[0]
            const sig = this.headSig(call, call.args)
            if (sig) {
                const inst = this.instantiateSignature(sig)
                this.inferSignatureArgs(call.args, inst)
                this.markVarMode(head.args[1], inst.sig.resultMode ?? 'out')
                if (inst.result) this.inferTerm(head.args[1], inst.result)
                return
            }
            // `X = Expr` 形式的头（少见）：两侧按统一推断
            this.inferUnify(head.args[0], head.args[1])
            return
        }
        const sig = this.headSig(head, head.args)
        if (!sig) return
        this.inferSignatureArgs(head.args, this.instantiateSignature(sig))
    }
    // 目标遍历（goal 位置：调用 p(args) / 统一 X = rhs）
    private inferGoal(term: Term) {
        switch (term.nameArity) {
            case '=/2':
            case '\\=/2':
                this.inferUnify(term.args[0], term.args[1])
                break
            case 'is/2': {
                // `Lhs is Rhs`：Rhs 是被求值的表达式（实参按 in），Lhs 是绑定结果（out）。
                // 不能走 inferUnify——它会把两边都标 out，且缺 this 分支时 is/2 会掉进
                // default 被当数据 functor，LHS 永远推不出类型（RHS 作为参数仍能推出）
                this.markVarMode(term.args[0], 'out')
                const lt = this.inferTerm(term.args[0])
                const rt = this.inferTerm(term.args[1], lt)
                this.tryUnify(lt, rt)
                break
            }
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
    // 调用：bottom-up 先推实参自然类型，pickSig 用纯合一筛候选消歧，
    // 胜出后 alignArgs 提交形参合一；选中签名记入 inferred.sig 供 hover 显示
    private inferCall(term: Term) {
        const argTypes = term.args.map(a => this.inferTerm(a))
        const picked = this.pickSig(this.callCandidates(term), term.args, argTypes)
        if (!picked) {
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
                const resolved = calleeType ? this.concreteNode(calleeType) : undefined
                let hoArgs: LType[]
                if (resolved && resolved.kind === 'ho' && resolved.args.length === n) {
                    hoArgs = resolved.args as unknown as LType[]
                } else {
                    hoArgs = Array.from({ length: n }, () => this.freshLogical() as LType)
                    const freshHo = {
                        kind: 'ho', pf: 'pred', args: hoArgs, result: this.freshLogical(),
                    } as LType
                    if (calleeType) this.unifyTypes(calleeType, freshHo)
                    else { const v = this.freshLogical() as LType; this.varTypes.set(calleeKey, v); this.unifyTypes(v, freshHo) }
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
        const sig0 = picked.sig
        const inst = this.instantiateSignature(sig0)
        this.alignArgs(term.args, argTypes, inst.args, inst.sig.argModes)
        const resultType = inst.result ?? this.freshLogical() as LType
        this.pendingInferred.set(term, { ltype: resultType, sig: sig0 })
    }
    // 试探性合一：失败把本次产生的绑定整体 undo 回 trail mark，不留半成品
    //（inferFunctor 逐个试探构造子/重载候选时，失败的候选不应留下绑定）。
    // 无参同义词展开（io→state 这类）：存储端的类型可能是未展开形式（变量早前
    // 绑的是 io），而签名形参侧经 resolveSynonym 展开成 state——不对称会让
    // unify(io, state) 误失败。只展开 body 无类型变量的
    // 同义词：带参数的（assoc_list）展开要代入调用点实参、破坏共享，
    // 那类仍由调用方显式 resolveSynonym 处理
    private resolveGroundSynonym(t: LType): LType {
        let cur = t
        for (let i = 0; i < 8; i++) {
            const p = this.concreteNode(cur)
            if (!p || p.kind !== 'ctor') return cur
            const ti = this.localTypeInfo(p.ctor)
                ?? this.exportManager.lookupType(p.ctor)
            if (!ti?.body || ti.params.length > 0 || this.countTypeVars(ti.body) > 0) return cur
            // body 无类型变量：instantiate 产出无变量的等价逻辑项
            cur = this.instantiate(ti.body)
        }
        return cur
    }
    private tryUnify(a: LType, b: LType): boolean {
        return this.unifyTypes(this.resolveGroundSynonym(a), this.resolveGroundSynonym(b))
    }
    // 统一目标：rhs 类型需与 lhs 一致；lhs 若已有具体类型（来自头签名）则约束 rhs。
    // 首次出现在绑定位置的变量记子句级 mode out（head 形参已在 inferHead 标记，不会被覆盖）
    private inferUnify(lhs: Term, rhs: Term) {
        this.markVarMode(lhs, 'out')
        this.markVarMode(rhs, 'out')
        const lt = this.inferTerm(lhs)
        const rt = this.inferTerm(rhs, lt)
        this.tryUnify(lt, rt)
    }
    private pushVarType(term: Term, t: LType) {
        const key = this.varKey(term)
        // 状态变量外层节点（!X / !.X / !:X）不在 varMap 里，parser 只收了内层 X；
        // 以前只写外层节点，hover 落在内层 X 上就只看到后续推断覆盖出的 unknown。
        const varMap = term.clause?.varMap ?? this.currentClause?.varMap
        const occurrences = varMap?.get(key) ?? []
        const mode = this.varMode.get(key)
        const info = { ltype: t, mode }
        this.pendingInferred.set(term, info)
        for (const occ of occurrences) this.pendingInferred.set(occ, info)
    }
    // 项/变量 → 类型（数据位置）；状态变量映射到底层变量名
    private inferTerm(term: Term, expected?: LType): LType {
        if (isVariable(term) || ['!/1', '!./1', '!:/1'].includes(term.nameArity)) {
            const key = this.varKey(term)
            let t = this.varTypes.get(key)
            if (!t) { t = this.freshLogical() as LType; this.varTypes.set(key, t) }
            if (expected) this.tryUnify(t, expected)
            this.pushVarType(term, t)
            return t
        }
        // 高阶表达式（func(...) = ... / (pred(...) is det) / 带 :- Body 的闭包）
        const ho = this.inferHigherOrder(term, expected)
        if (ho) return ho

        const st = term.syntaxType
        const lit = (name: string): LType => ({ kind: 'ctor', ctor: { name, arity: 0 }, args: [] })
        if (st === 'integer') { const t = lit('int'); this.pendingInferred.set(term, { ltype: t }); return t }
        if (st === 'float') { const t = lit('float'); this.pendingInferred.set(term, { ltype: t }); return t }
        if (st === 'string') { const t = lit('string'); this.pendingInferred.set(term, { ltype: t }); return t }
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
            this.pendingInferred.set(term, { ltype: t })
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
            // .qualified 统一为点分前缀字符串（与 visitQualifiedTerm 一致）
            if (t.args[0]) right.qualified = moduleQualifiedName(t.args[0])
            t = right
        }
        return t
    }
    // 列表字面量：元素类型由 expected（list(E)）给定，否则新建类型变量
    private inferList(term: Term, expected?: LType): LType {
        let elemType: LType = this.freshLogical() as LType
        // 展开类型同义词：assoc_list(K,V) == list(pair(K,V)) → 取 list 元素类型 pair(K,V)
        if (expected) {
            const resolved = this.concreteNode(this.resolveSynonym(expected))
            if (resolved && resolved.kind === 'ctor' && resolved.ctor.name === 'list' && !resolved.ctor.module && resolved.args.length === 1) {
                elemType = resolved.args[0] as unknown as LType
            }
        }
        const listType = (): LType => ({ kind: 'ctor', ctor: { name: 'list', arity: 1 }, args: [elemType] })
        const walk = (t: Term) => {
            if (t.nameArity === '[]/0') {
                // 空表也是 list 的构造子
                this.pendingInferred.set(t, { ltype: listType(), category: 'constructor' })
                return
            }
            if (t.nameArity === '[|]/2') {
                // [|]/2 恒为 list 的 cons 构造子（Mer 无法重定义）
                this.pendingInferred.set(t, { ltype: listType(), category: 'constructor' })
                this.inferTerm(t.args[0], elemType)
                walk(t.args[1])
                return
            }
            // 可能直接是变量尾（!.List / Tail）
            this.inferTerm(t, listType())
        }
        walk(term)
        // 整表项（[|]/2 或 []/0）同样标为 list 构造子
        const category = (term.nameArity === '[|]/2' || term.nameArity === '[]/0') ? 'constructor' : undefined
        const result = listType()
        this.pendingInferred.set(term, { ltype: result, category })
        return result
    }
    // 展开类型同义词（equivalence type，type T == U）：把 T(A,..) 还原为 U（实参
    // 是活逻辑项，体里的类型参数经 env 直接代入，不再拷贝）；本地 this.types 与
    // 跨模块 exportManager 都查。非同义词原样返回。
    private resolveSynonym(t: LType): LType {
        const p = this.concreteNode(t)
        if (!p || p.kind !== 'ctor') return t
        const ti = this.localTypeInfo(p.ctor) ?? this.exportManager.lookupType(p.ctor)
        if (!ti || !ti.body) return t
        const env = new Map<string, LType>()
        for (let i = 0; i < ti.params.length; i++) {
            const param = ti.params[i]
            const arg = p.args[i] as unknown as LType | undefined
            if (param.kind === 'var' && arg !== undefined) env.set(param.name, arg)
        }
        return this.instantiate(ti.body, env)
    }
    // 构造子名 → ConsInfo 候选（本模块）：typesVersion 变化时惰性重建，
    // 保持「边 visit 边可见」的实时语义（前向声明的类型在 addTypeInfo 后即可查）
    private consByName(name: string): ConsInfo[] {
        if (this.consIndex?.v !== this.typesVersion) {
            const map = new Map<string, ConsInfo[]>()
            for (const arr of this.types.values()) {
                for (const ti of arr) {
                    for (const ci of ti.constructors) {
                        const a = map.get(ci.ctor)
                        if (a) a.push(ci)
                        else map.set(ci.ctor, [ci])
                    }
                }
            }
            this.consIndex = { v: this.typesVersion, map }
        }
        return this.consIndex.map.get(name) ?? []
    }
    // 数据位置 functor：用 expected 类型与签名消歧 构造子/函数；重载且类型无法唯一确定时保持无类别
    // allowFreeze=false 用于 frozen 重试：重试仍失败时不再重复挂起（goal 自己控制重试节奏）
    private inferFunctor(term: Term, expected?: LType, allowFreeze = true): LType {
        const name = term.name
        const arity = term.arity
        // bottom-up：先推实参拿真实类型——消歧建立在实测类型上（不再靠
        // quickArgType 猜测）；实参内部消歧不足由各自项的 freeze goal
        // 在绑定后唤醒补齐
        const argTypes = term.args.map(a => this.inferTerm(a))
        const expNode = this.concreteNode(expected)
        const expCtor = expNode && expNode.kind === 'ctor' ? expNode.ctor : undefined
        const constrs: ConsInfo[] = []
        for (const ci of this.consByName(name)) {
            if (ci.arity === arity) constrs.push(ci)
        }
        // 跨模块：类型上下文明确时，纳入导入模块里同名同元数的类型构造子。
        // 导出索引按类型构造子键定位，直接查目标类型即可（原全表扫是 O(类型数)）
        if (expCtor) {
            const ti = this.exportManager.lookupType(expCtor)
            if (ti) {
                for (const ci of ti.constructors) {
                    if (ci.ctor === name && ci.arity === arity) constrs.push(ci)
                }
            }
        }
        // 函数签名候选：限定名只看目标模块；否则本模块声明优先（遮蔽导入），
        // 本模块没有时回退全局导出索引。hasOwnFunc 区分候选是否来自本模块，
        // 供无类型上下文时的保守消歧规则使用
        const funcCands = this.funcCandidates(term)
        // 自限定名（array.m 里的 array.f）等价于无限定：候选来自本模块，
        // 不触发"限定名直取目标模块"的 qualPick 捷径，走常规消歧规则
        const selfQ = this.isSelfQualified(term.qualified)
        const hasOwnFunc = (!term.qualified || selfQ)
            && sigCandidates(this.sigAlts, name, term.semanticArity, term.arity, 'func').length > 0
        let fComputed = false
        let fCache: { sig: FuncInfo; verified: boolean } | undefined
        const pickFunc = () => {
            if (!fComputed) { fCache = this.pickSig(funcCands, term.args, argTypes); fComputed = true }
            return fCache
        }

        // 被选中项的实例化类型：每个候选/签名使用点各 instantiate 一组逻辑
        // 变量（模板类型变量共享同一逻辑变量），与 unifyTypes 写入 trail 的
        // 绑定一致，供参数对齐与结果类型使用
        let instArgTypes: LType[] | undefined
        let instResultType: LType | undefined
        const useCI = (ci: ConsInfo) => {
            const inst = this.instantiateCons(ci)
            instArgTypes = inst.args
            instResultType = inst.result
        }
        const useFunc = (f: FuncInfo) => {
            const s = this.instantiateSignature(f)
            instArgTypes = s.args
            instResultType = s.result
        }

        let chosenCI: ConsInfo | undefined
        let chosenFunc: FuncInfo | undefined
        // 限定名 M.f(...)（外部模块）：func 候选只来自目标模块（重载经 pickSig
        // 试解消歧）；无 func 候选时落入下方构造子消歧
        const qualPick = term.qualified && !selfQ ? pickFunc()?.sig : undefined
        if (qualPick) {
            chosenFunc = qualPick
            useFunc(qualPick)
        } else if (expCtor) {
            // 类型上下文明确：取首个能合一的构造子；否则若 func 结果类型能合一则取 func
            // （跨模块 func 仅在类型上下文明确时参与，避免把无类型上下文的重载项误标）
            // 逐候选实例化+试探合一：每个候选是独立类型实例，失败候选不得留下
            // 绑定（tryUnify/unifyTypes 失败自动 undo trail），且只有命中的构造子
            // 提交其合一结果
            for (const ci of constrs) {
                const inst = this.instantiateCons(ci)
                if (this.tryUnify(inst.result, expected!)) {
                    chosenCI = ci
                    instArgTypes = inst.args
                    instResultType = inst.result
                    break
                }
            }
            const f = pickFunc()
            if (!chosenCI && f) {
                chosenFunc = f.sig
                useFunc(f.sig)
            }
        } else {
            // 类型未知：本模块符号优先消歧；跨模块 func 仅在实参类型经试解唯一确定时引入
            //（pickSig 无已知实参类型/并列成功时返回 undefined，不会误标）
            const f = pickFunc()
            if (hasOwnFunc && constrs.length === 0) {
                if (f) { chosenFunc = f.sig; useFunc(f.sig) }
            } else if (!hasOwnFunc && constrs.length === 1) {
                chosenCI = constrs[0]
                useCI(constrs[0])
            } else if (hasOwnFunc && constrs.length >= 1 && f && f.sig.argTypes.length === arity) {
                chosenFunc = f.sig
                useFunc(f.sig)
            } else if (!hasOwnFunc && constrs.length === 0 && f
                && (f.verified || !this.hasCrossConstrs(name, arity))) {
                // 跨模块 func 候选：实参类型经试解唯一确定（verified）时采信，
                // 即使存在同名同元数的跨模块构造子——实参类型是更强的证据
                //（如 int 实参的 `H0 - H` 应选 int.- 而非 pair 的 `-` 构造子）；
                // 未经试解验证（单候选+实参未知）且存在跨模块构造子时才保守不标
                chosenFunc = f.sig
                useFunc(f.sig)
            }
            // 其余（多构造子无 func、func+构造子但参数元数不符）无法消歧 → 留无类别
        }

        const resultType = instResultType ?? this.freshLogical() as LType
        const category = chosenCI ? 'constructor' as const : chosenFunc ? 'func' as const : undefined

        // 提交：实参类型与被选中项形参类型合一（cons/func 同规则；
        // 无候选时 instArgTypes 为空、跳过——等价旧 fresh 变量 expected）
        this.alignArgs(term.args, argTypes, instArgTypes)
        this.pendingInferred.set(term, { ltype: resultType, category, sig: chosenFunc })
        // freeze：信息不足导致的消歧失败（如 stream/4 双构造子、重载 func 实参未知），
        // 把重试 goal 挂到消歧依赖的活逻辑变量上——等结果类型被后续 goal 绑定
        //（或实参类型有新进展）时由 wakeGoals 同步唤醒，等价于 Mercury freeze/2。
        // 注意跨模块构造子在无类型上下文时不进 constrs（见上方 expCtor 收集条件），
        // 必须用 hasCrossConstrs 补上——否则构造子全在导入模块里时根本不挂起；
        // frozenTerms 去重：goal 重试/嵌套推断重复走到同一项时不重复登记
        if (allowFreeze && !this.frozenTerms.has(term)
            && !chosenCI && !chosenFunc
            && (constrs.length > 0 || funcCands.length > 0 || this.hasCrossConstrs(name, arity))) {
            this.frozenTerms.add(term)
            let lastScore = -1
            let done = false
            // watch：结果类型变量 + 每个实参推断类型的链尾自由变量——
            // 实参是活逻辑项，其内部变量的进展会传导到 argTypes[i] 的形态
            const watchVars = new Set<LogicVar>()
            const addWatch = (t: LType | undefined) => {
                if (t === undefined) return
                const d = derefTerm(t)
                if (isUnboundLogicalVar(d as object)) watchVars.add(d as LogicVar)
            }
            addWatch(resultType)
            for (const t of argTypes) addWatch(t)
            const goal = (): boolean => {
                // LS 容错：恒返回 true（不视合一失败回滚外层绑定）
                if (done) return true
                try {
                    const rn = this.concreteNode(resultType)
                    const expectedT = rn?.kind === 'ctor' ? this.resolveSynonym(resultType) : undefined
                    const knownArgs = argTypes.reduce((n, t) => n + (this.isKnownType(t) ? 1 : 0), 0)
                    // 进展分：结果类型落地权重最高；实参已知类型数次之。
                    // 分数不变说明自上次重试没有新信息，跳过昂贵的重载试解
                    const score = (expectedT ? 1 << 20 : 0) + knownArgs
                    if (score !== lastScore) {
                        lastScore = score
                        if (expectedT || knownArgs > 0) {
                            this.inferFunctor(term, expectedT, false)
                            const after = this.pendingInferred.get(term)
                            if (after?.category ?? after?.sig) {
                                done = true
                                this.frozenTerms.delete(term)
                            }
                        }
                    }
                } catch {
                    // goal 内部异常视为放弃本轮（不影响合一主流程）
                }
                return true
            }
            for (const v of watchVars) freeze(v, goal, this.trail)
        }
        return resultType
    }
    // 高阶表达式：func(Head) = Result | (pred(Head) is Det) | 带 :- Body 的闭包。
    // 用 expected 的 ho 签名给闭包头绑定变量赋类型，并递归推断闭包头/体。
    private inferHigherOrder(term: Term, expected?: LType): LType | undefined {
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
            if (!t) { t = this.freshLogical() as LType; this.varTypes.set(key, t) }
            return t
        })
        const resultType = this.freshLogical() as LType
        const expNode = this.concreteNode(expected)
        if (expNode && expNode.kind === 'ho') {
            // 期望的高阶签名对闭包头/结果的约束要么整体成立、要么整体放弃：
            // 逐个 unify 会在中途失败时留下部分绑定（如第 2 个参数不匹配但第 1 个已绑定）
            const ea = expNode.args as unknown as LType[]
            const er = expNode.result as LType | undefined
            const mark = this.trail.length
            let ok = true
            for (let i = 0; i < argTypes.length && i < ea.length; i++) {
                if (!this.unifyTypes(argTypes[i], ea[i])) { ok = false; break }
            }
            if (ok && er && !this.unifyTypes(resultType, er)) ok = false
            if (!ok) undo(this.trail, mark)
        }
        // ho 恒带 result（pred 也占位自由变量），保证与其他 ho 逻辑项形状一致
        const hoType = { kind: 'ho', pf, args: argTypes, result: resultType } as LType
        if (resultTerm) this.inferTerm(resultTerm, resultType)
        if (bodyTerm) this.inferGoal(bodyTerm)
        this.pendingInferred.set(term, { ltype: hoType })
        return hoType
    }
    private hoHeadVar(argTerm: Term): Term {
        if (['::/2', '>>/2'].includes(argTerm.nameArity)) return argTerm.args[0]
        return argTerm
    }
    // 重载候选收集：同一 name 的每条声明都保留（签名不同才算不同候选，
    // 重复声明同一签名去重——如 interface/implementation 两段都声明时；
    // kind+arity 进签名键，func/pred 同签名与不同元数都不误去重）
    private pushAlt(map: Map<string, FuncInfo[]>, name: string, info: FuncInfo) {
        const sig = JSON.stringify({ k: info.kind, a: info.arity, t: info.argTypes, r: info.resultType })
        const arr = map.get(name)
        if (arr) {
            if (!arr.some(f => JSON.stringify({ k: f.kind, a: f.arity, t: f.argTypes, r: f.resultType }) === sig)) arr.push(info)
        } else {
            map.set(name, [info])
        }
    }
    private countTypeVars(t: MerType): number {
        if (t.kind === 'var') return 1
        if (t.kind === 'ctor') return t.args.reduce((s, a) => s + this.countTypeVars(a), 0)
        return t.args.reduce((s, a) => s + this.countTypeVars(a), 0) + (t.result ? this.countTypeVars(t.result) : 0)
    }
    // 实参对齐：markVarMode（call 签名 argModes）+ 实参类型与形参类型合一。
    // 实参已由调用方 bottom-up 预推断（inferTerm 无 expected），这里只做合一
    // 不重推——实参内部消歧不足由其自身 freeze goal 在绑定后唤醒补齐。
    // 变量实参的 pendingInferred 在预推时 mode 尚未标记，末尾补写一次带
    // mode 的条目（pushVarType 覆盖同 key，occurrences 同步）
    private alignArgs(args: Term[], argTypes: LType[], params: LType[] | undefined, modes?: (string | undefined)[]) {
        let ti = 0
        for (let i = 0; i < args.length; i++) {
            if (modes) this.markVarMode(args[i], modes[ti] ?? 'in')
            const param = params?.[ti]
            ti += this.argWidth(args[i])
            if (param === undefined) continue
            // 形参先展开同义词（assoc_list → list(pair(K,V))）：实参侧的
            // 活逻辑项经 env 直接代入，不展开会 unify(list, assoc_list) 误失败；
            // 实参侧可能的无参同义词（state/io）由 tryUnify 的 ground 展开兜底
            this.tryUnify(argTypes[i], this.resolveSynonym(param))
        }
        if (modes) {
            for (let i = 0; i < args.length; i++) {
                const a = args[i]
                if (isVariable(a) || ['!/1', '!./1', '!:/1'].includes(a.nameArity)) {
                    this.pushVarType(a, argTypes[i])
                }
            }
        }
    }
    // 重载候选消歧（bottom-up 纯合一）：实参已预推断成 LType，对每个候选
    // 实例化签名、把实参类型与形参类型逐对合一（trail mark/undo 试探，
    // 失败不留绑定）——这是真正的合一判定，复合实参、共享类型变量都自然
    // 覆盖，不是启发式打分。多个候选都成功时取类型变量最少者（最具体的
    // 签名）；仍并列或全失败则返回 undefined（不猜，保持无类别）。
    // 返回 verified=true 表示该签名合一判定唯一胜出（实参类型确实支持它）；
    // verified=false 仅出现在「单候选 + 实参类型全未知」的弱返回——调用方在
    // func/构造子歧义场景应据此保持无类别，而不是直接采信
    private pickSig(cands: FuncInfo[], args: Term[], argTypes: LType[]): { sig: FuncInfo; verified: boolean } | undefined {
        if (cands.length === 0) return undefined
        // 没有任何实参带已知类型时，所有候选都会"成功"，合一判定无意义 →
        // 直接歧义；仅单候选时弱返回，多候选判歧义
        const hasKnown = argTypes.some(t => this.isKnownType(t))
        if (!hasKnown) {
            return cands.length === 1 ? { sig: cands[0], verified: false } : undefined
        }
        const successes: { sig: FuncInfo; vars: number }[] = []
        for (const c of cands) {
            const inst = this.instantiateSignature(c)
            const mark = this.trail.length
            let ok = true
            let ti = 0
            for (let i = 0; i < args.length; i++) {
                const param = inst.args[ti]
                ti += this.argWidth(args[i])
                if (param === undefined) continue
                if (!this.tryUnify(argTypes[i], this.resolveSynonym(param))) { ok = false; break }
            }
            // 试探绑定一律 undo：胜者由 alignArgs 在正式路径重新合一提交
            undo(this.trail, mark)
            if (ok) successes.push({ sig: c, vars: c.argTypes.reduce((s, a) => s + this.countTypeVars(a), 0) })
        }
        if (successes.length === 0) return undefined
        successes.sort((a, b) => a.vars - b.vars)
        if (successes.length > 1 && successes[1].vars === successes[0].vars) return undefined
        return { sig: successes[0].sig, verified: true }
    }
    // 是否存在同名同元数的跨模块类型构造子（导出索引内）；
    // 用于无类型上下文时判断 func/构造子是否歧义
    private hasCrossConstrs(name: string, arity: number): boolean {
        return this.exportManager.hasCtor(name, arity)
    }
    // 限定名是否指向当前模块自身（如 array.m 里的 array.size）：
    // 模块要等 visit 完才注册进 moduleManager，自限定调用必须按本模块符号解析，
    // 否则在自身 visit 期间永远查不到（首遍推断失败 → 重建后表现为类型回退）
    private isSelfQualified(qualified: string | undefined): boolean {
        return !!(qualified && this.module && qualified === this.localModuleName())
    }
    // 限定模块名 → 文档：精确名优先；miss 时以本模块名为前缀再试
    //（module io 里的 stream_ops.f = io.stream_ops.f——相对限定引用）。
    // 解析上下文在这层而非 moduleManager.get：get 保持纯字符串查找
    private qualifiedModuleDoc(qualified: string | undefined) {
        if (!qualified) return undefined
        const exact = this.moduleManager.get(qualified)
        if (exact) return exact
        const self = this.localModuleName()
        return self ? this.moduleManager.get(`${self}.${qualified}`) : undefined
    }
    // term 限定名的签名作用域：'self' = 自限定（硬作用域，只看本模块，
    // 不回退导出索引）；Map = 外部限定目标模块的 sigAlts；undefined = 无限定名
    private qualifiedSigScope(term: Term): 'self' | Map<string, FuncInfo[]> | undefined {
        if (!term.qualified) return undefined
        if (this.isSelfQualified(term.qualified)) return 'self'
        return this.qualifiedModuleDoc(term.qualified)?.visitResult?.sigAlts
    }
    // goal 位置调用的签名候选：限定名只看目标模块；否则本模块声明优先（遮蔽导入），
    // 本模块没有时回退全局导出索引（偏宽，由 pickSig 的实参类型消歧兜底）
    private callCandidates(term: Term): FuncInfo[] {
        const name = term.name, sem = term.semanticArity, alt = term.arity
        const both = (map: Map<string, FuncInfo[]>) => [
            ...sigCandidates(map, name, sem, alt, 'func'),
            ...sigCandidates(map, name, sem, alt, 'pred'),
        ]
        const scope = this.qualifiedSigScope(term)
        if (scope !== undefined) {
            const map = scope === 'self' ? this.sigAlts : scope
            return map ? both(map) : []
        }
        // 无限定名：本模块声明 ∪ 全局导出索引——Mercury 语义里本地声明不硬
        // 遮蔽导入，同名候选全部可见，由 pickSig 按实参类型消歧
        //（string.m 里 list(int) 实参的 `++` 要能选中 list.++ 而非本模块
        // 的 string.++）
        const local = both(this.sigAlts)
        return this.mergeSigCandidates(local, this.exportManager.lookupSigAlts(name, sem, alt))
    }
    // 数据位置 functor 的函数候选（构造子另行收集；pred 不进入项位置）。
    // 同 callCandidates：本地 ∪ 导出索引，类型消歧决定胜者
    private funcCandidates(term: Term): FuncInfo[] {
        const name = term.name, sem = term.semanticArity, alt = term.arity
        const scope = this.qualifiedSigScope(term)
        if (scope !== undefined) {
            const map = scope === 'self' ? this.sigAlts : scope
            return map ? sigCandidates(map, name, sem, alt, 'func') : []
        }
        const own = sigCandidates(this.sigAlts, name, sem, alt, 'func')
        return this.mergeSigCandidates(own, this.exportManager.lookupFuncAlts(name, sem, alt))
    }
    // 本地候选 ∪ 全局候选：同一声明可能两边都出现（本模块导出符号也进
    // 导出索引），按 完整签名+模块 去重；不同模块的同签名声明保留
    private mergeSigCandidates(local: FuncInfo[], global: FuncInfo[]): FuncInfo[] {
        if (!local.length) return global
        if (!global.length) return local
        const key = (f: FuncInfo) => JSON.stringify({ k: f.kind, a: f.arity, m: f.module, t: f.argTypes, r: f.resultType })
        const seen = new Set(local.map(key))
        return [...local, ...global.filter(f => !seen.has(key(f)))]
    }
    // 头位置签名：收集候选后按头实参已知类型消歧（pickSig 试解，与调用点同一
    // 套机制）；唯一/弱单候选返回实例化签名，歧义 → undefined（不猜）
    private headSig(termOrName: Term | string, args?: Term[]): FuncInfo | undefined {
        const cands = this.signatureCandidates(termOrName)
        if (cands.length === 0) return undefined
        const argTerms = args ?? (typeof termOrName === 'string' ? [] : termOrName.args ?? [])
        // 头实参此刻尚未推断（inferSignatureArgs 在选中签名后才跑），
        // 类型全未知 → pickSig 走弱返回/歧义，与旧 quickArgType 口径一致
        const picked = this.pickSig(cands, argTerms, argTerms.map(() => this.freshLogical() as LType))
        return picked?.sig ?? undefined
    }
    // 声明里的签名是纯 MerType 模板（只读）；每个使用点经 instantiateSignature
    // 实例化成活逻辑项（见 LType 基础设施段）

    // 头位置签名候选：与 callCandidates 同一套 scope 规则（自限定硬作用域 /
    // 外部限定目标模块 / 本模块优先回退导出索引），返回 func+pred 全部候选，
    // 由 headSig 的 pickSig 按实参类型消歧——不在此层做单值取舍
    private signatureCandidates(termOrName: Term | string, arity?: number): FuncInfo[] {
        const name = typeof termOrName === 'string' ? termOrName : termOrName.name
        const a = typeof termOrName === 'string' ? arity! : termOrName.semanticArity
        // 状态变量 !X 在语义元数上按两个参数（!.X / !:X）计，但声明处常按单个逻辑参数计（如
        // `:- pred p(list(T)::out)` 配 `p(!List)`）。两种元数都查一次，兼容这种写法。
        const aAlt = typeof termOrName === 'string' ? a : termOrName.arity
        const both = (map: Map<string, FuncInfo[]>) => [
            ...sigCandidates(map, name, a, aAlt, 'func'),
            ...sigCandidates(map, name, a, aAlt, 'pred'),
        ]
        if (typeof termOrName !== 'string' && termOrName.qualified) {
            const scope = this.qualifiedSigScope(termOrName)
            // 自限定：硬作用域，只看本模块（不回退导出索引）
            if (scope === 'self') return both(this.sigAlts)
            const cands = scope ? both(scope) : []
            if (cands.length) return cands
            // 外部限定未命中 → 继续走无限定兜底（与旧 signatureOf 语义一致）
        }
        // 与 callCandidates 同规则：本地 ∪ 导出索引（本地不硬遮蔽导入）
        const local = both(this.sigAlts)
        return this.mergeSigCandidates(local, this.exportManager.lookupSigAlts(name, a, aAlt))
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
