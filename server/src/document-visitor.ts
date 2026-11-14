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
    applySubst, ConsInfo, FuncInfo, InferredInfo, MerType, TypeCtor, TypeInfo,
    keyOf, keyOfTypeCtor, modeOfArg, argModesOf, termToMerType, typeHeadParts, unify,
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
    types: Map<string, TypeInfo>          // 类型构造子 → 类型定义（含构造子列表）
    funcs: Map<string, FuncInfo>          // 函数签名（name/arity → 参数+返回类型）
    preds: Map<string, FuncInfo>          // 谓词签名（name/arity → 参数类型）
    // 同名同元数的全部声明签名（重载候选；funcs/preds 只存最后一个，供签名查找兜底）
    funcAlts: Map<string, FuncInfo[]>
    predAlts: Map<string, FuncInfo[]>
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
    types = new Map<string, TypeInfo>()
    funcs = new Map<string, FuncInfo>()
    preds = new Map<string, FuncInfo>()
    funcAlts = new Map<string, FuncInfo[]>()
    predAlts = new Map<string, FuncInfo[]>()
    modeSigs = new Map<string, string[]>()
    instDefs = new Map<string, InstDef>()
    modeDefs = new Map<string, ModeDef>()
    inferred = new Map<Term, InferredInfo>()
    // 正在收集的类型定义（visitTypeConstrutor 往里追加构造子）
    private currentType?: TypeInfo
    // 类型推断工作态（每个子句重置）
    private subst = new Map<string, MerType>()
    private varTypes = new Map<string, MerType>()
    // 提交性合一失败计数：trialSig 试解重载候选时统计（探测性失败不计）
    private unifyFailed = 0
    // 变量子句级 mode 近似（head 形参声明 mode / 绑定变量 out / 调用 in 实参；类型推断步骤填充，供 hover 显示）
    private varMode = new Map<string, string>()
    private varCounter = 0
    // freeze 式延迟约束：消歧失败（信息不足）的 functor 项登记 goal + watch
    // 列表（结果类型变量 + 直接变量实参的类型变量），每次 tryUnify 提交后
    // drain——只对 watch 解析结果发生变化的 goal 做评分/重试（等价于 Mercury
    // freeze/2 的「变量绑定时唤醒」，但按名解析变化检测，兼容 subst 别名链）。
    // goal 返回 true 表示已解决/放弃（移除），false 继续等下一次变化
    private frozen: { term: Term; watches: { t: MerType; last: string }[]; goal: () => boolean }[] = []
    // 同一 Term 只挂一次冻结（trialSig 试解会重复遍历实参，无去重会无限堆积）
    private frozenTerms = new Set<Term>()
    private drainingFrozen = false
    // trialSig 试解期间克隆了 subst/varTypes，tryUnify 的提交不代表真实进展，
    // 期间不触发 drain（否则 goal 会在克隆状态上误判/误写）
    private inTrialDepth = 0
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
            funcs: this.funcs,
            preds: this.preds,
            funcAlts: this.funcAlts,
            predAlts: this.predAlts,
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
        // 本模块表按裸 name/arity 键（模块内不可能同名同元数重复定义）；
        // ctor.module 仍记录模块名，导出索引（ExportManager）用 qualified 键
        this.types.set(keyOf(info.ctor.name, info.ctor.arity), info)
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
        const local = this.types.get(keyOf(ctor.name, ctor.arity))
        if (local) return local.ctor.module ?? this.localModuleName()
        return this.exportManager.lookupType(ctor)?.ctor.module
    }
    // 本模块类型查询：限定名只匹配同模块声明（ctor.module 与本模块名一致），
    // 未限定名按 name/arity 命中本模块表
    private localTypeInfo(ctor: TypeCtor): TypeInfo | undefined {
        const ti = this.types.get(keyOf(ctor.name, ctor.arity))
        if (!ti) return undefined
        if (ctor.module && ti.ctor.module && ctor.module !== ti.ctor.module) return undefined
        return ti
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
        const fi = this.preds.get(key)
        if (fi) {
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
        const key = keyOf(func.name, func.semanticArity)
        const info: FuncInfo = {
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
        this.funcs.set(key, info)
        this.pushAlt(this.funcAlts, key, info)
        // 每个 mode 声明一行（Mercury 默认 mode：参数 in，函数结果 out）；带确定性后缀
        const modes = func.args.map(modeOfArg).map(m => m ?? 'in')
        const rm = ret ? modeOfArg(ret) ?? 'out' : 'out'
        const det = determinism ? ` is ${determinism}` : ''
        this.pushModeSig(keyOf(func.name, func.semanticArity), `${this.qualDisplayName(func.name)}(${modes.join(', ')}) = (${rm})${det}`)
    }
    // 记录谓词签名（name/arity → 参数类型/mode；谓词无返回类型）
    private recordPredInfo(pred: Term, determinism?: string) {
        const argRefs = pred.args.map(a => this.argModeRefOf(a))
        const key = keyOf(pred.name, pred.semanticArity)
        const info: FuncInfo = {
            name: pred.name, arity: pred.semanticArity, module: this.localModuleName(),
            argTypes: this.shareTypeParams(pred.args.map(a => this.toMerType(a))),
            argModes: argModesOf(pred.args),
            argModeRefs: argRefs,
            hasExplicitModes: this.hasExplicitModes(pred.args),
            modes: this.hasExplicitModes(pred.args)
                ? [{ argModeRefs: argRefs, det: determinism }]
                : [],
        }
        this.preds.set(key, info)
        this.pushAlt(this.predAlts, key, info)
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
        this.subst = new Map()
        this.varTypes = new Map()
        this.varMode = new Map()
        this.varCounter = 0
        this.frozen = []
        this.frozenTerms = new Set()
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
            const sig = this.sigAt(call)
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
        const sig = this.sigAt(head)
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
            case 'is/2': {
                // `Lhs is Rhs`：Rhs 是被求值的表达式（实参按 in），Lhs 是绑定结果（out）。
                // 不能走 inferUnify——它会把两边都标 out，且缺 this 分支时 is/2 会掉进
                // default 被当数据 functor，LHS 永远推不出类型（RHS 作为参数仍能推出）
                this.markVarMode(term.args[0], 'out')
                const lt = this.inferTerm(term.args[0])
                const rt = this.inferTerm(term.args[1], lt)
                this.tryUnify(lt, rt)
                this.refreshVarTypes(term.args[0])
                this.refreshVarTypes(term.args[1])
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
    // 调用：按签名对齐实参类型；同名重载候选经 trialSig 试解消歧，
    // 选中签名记入 inferred.sig 供 hover 显示
    private inferCall(term: Term) {
        const picked = this.pickSig(this.callCandidates(term), term.args)
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
                const resolved = calleeType ? applySubst(calleeType, this.subst) : undefined
                let hoArgs: MerType[]
                if (resolved && resolved.kind === 'ho' && resolved.args.length === n) {
                    hoArgs = resolved.args
                } else {
                    hoArgs = Array.from({ length: n }, () => ({ kind: 'var', name: this.freshVar() } as MerType))
                    const freshHo: MerType = { kind: 'ho', pf: 'pred', args: hoArgs }
                    if (calleeType) this.tryUnify(calleeType, freshHo, true)
                    else { const v: MerType = { kind: 'var', name: this.freshVar() }; this.varTypes.set(calleeKey, v); this.tryUnify(v, freshHo, true) }
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
        const sig = this.freshenSig(sig0)
        this.inferSignatureArgs(term.args, sig)
        this.inferred.set(term, {
            type: sig.resultType ? applySubst(sig.resultType, this.subst) : { kind: 'var', name: this.freshVar() },
            sig: sig0,
        })
    }
    // 试探性合一：在 subst 副本上运行，成功才提交；失败不留半成品绑定。
    // unify 本身就地修改 subst，中途失败会留下已绑定的变量，污染后续推断
    //（如 inferFunctor 逐个试探构造子候选时，失败的候选不应留下绑定）。
    // probe=true 表示「试探性合一」（构造子/闭包候选消歧），失败属正常不计入
    // unifyFailed；提交性合一（inferUnify、变量 expected）失败计入，供 trialSig 判定。
    // 无参同义词展开（io→state 这类）：存储端的类型可能是未展开形式（变量早前
    // 绑的是 io），而签名形参侧经 resolveSynonym 展开成 state——不对称会让
    // unify(io, state) 误失败、整条签名试解被拒。只展开 body 无类型变量的
    // 同义词：带参数的（assoc_list）展开要 freshen 类型变量、破坏共享，
    // 那类仍由调用方显式 resolveSynonym 处理
    private resolveGroundSynonym(t: MerType): MerType {
        let cur = t
        for (let i = 0; i < 8; i++) {
            if (cur.kind !== 'ctor') return cur
            const ti = this.localTypeInfo(cur.ctor)
                ?? this.exportManager.lookupType(cur.ctor)
            if (!ti?.body || ti.params.length > 0 || this.countTypeVars(ti.body) > 0) return cur
            cur = ti.body
        }
        return cur
    }
    private tryUnify(a: MerType, b: MerType, probe = false): boolean {
        const trial = new Map(this.subst)
        if (!unify(this.resolveGroundSynonym(a), this.resolveGroundSynonym(b), trial)) {
            if (!probe) this.unifyFailed++
            return false
        }
        this.subst = trial
        // 提交成功 = 类型变量有新绑定 → 唤醒 frozen 队列里的延迟消歧目标；
        // 试解（trialSig）期间状态是克隆的，不算真实进展，不触发
        if (this.inTrialDepth === 0) this.drainFrozen()
        return true
    }
    // watch 解析键：变量跟随别名链取终端名（?N→?S→ctor 时依次变化，
    // 每次变化都能被检测到）；ctor 按名字+元数
    private watchKey(t: MerType): string {
        const r = applySubst(t, this.subst)
        if (r.kind === 'var') return `v:${r.name}`
        if (r.kind === 'ctor') return `c:${keyOfTypeCtor(r.ctor)}`
        return 'ho'
    }
    // drain frozen 队列：只对 watch 解析键发生变化的 goal 调用 goal()；
    // goal 返回 true 移除，false 保留。循环到无变化为止（一个 goal 的重试
    // 可能绑定新变量、级联唤醒其它 goal）；goal 内部抛错视为放弃该项
    private drainFrozen() {
        if (this.drainingFrozen) return
        this.drainingFrozen = true
        try {
            for (;;) {
                let ran = false
                for (let i = this.frozen.length - 1; i >= 0; i--) {
                    const f = this.frozen[i]
                    let changed = false
                    for (const w of f.watches) {
                        const k = this.watchKey(w.t)
                        if (k !== w.last) { w.last = k; changed = true }
                    }
                    if (!changed) continue
                    ran = true
                    let done: boolean
                    try {
                        done = f.goal()
                    } catch {
                        done = true
                    }
                    if (done) { this.frozen.splice(i, 1); this.frozenTerms.delete(f.term) }
                }
                if (!ran || this.frozen.length === 0) break
            }
        } finally {
            this.drainingFrozen = false
        }
    }
    // 统一目标：rhs 类型需与 lhs 一致；lhs 若已有具体类型（来自头签名）则约束 rhs。
    // 首次出现在绑定位置的变量记子句级 mode out（head 形参已在 inferHead 标记，不会被覆盖）
    private inferUnify(lhs: Term, rhs: Term) {
        this.markVarMode(lhs, 'out')
        this.markVarMode(rhs, 'out')
        const lt = this.inferTerm(lhs)
        const rt = this.inferTerm(rhs, lt)
        this.tryUnify(lt, rt)
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
            if (expected) this.tryUnify(t, expected)
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
            // .qualified 统一为点分前缀字符串（与 visitQualifiedTerm 一致）
            if (t.args[0]) right.qualified = moduleQualifiedName(t.args[0])
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
            if (resolved.kind === 'ctor' && resolved.ctor.name === 'list' && !resolved.ctor.module && resolved.args.length === 1) {
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
        const ti = this.localTypeInfo(t.ctor) ?? this.exportManager.lookupType(t.ctor)
        if (!ti || !ti.body) return t
        const subst = new Map<string, MerType>()
        for (let i = 0; i < ti.params.length; i++) {
            const p = ti.params[i]
            if (p.kind === 'var' && t.args[i]) subst.set(p.name, t.args[i])
        }
        // 展开结果里残留的具名类型变量（非形参的游离变量）同样按本次使用实例化，
        // 避免与其它声明的同名类型变量在 subst 里串扰
        return this.freshenType(applySubst(ti.body, subst), new Map())
    }
    // 数据位置 functor：用 expected 类型与签名消歧 构造子/函数；重载且类型无法唯一确定时保持无类别
    // allowFreeze=false 用于 frozen 重试：重试仍失败时不再重复挂起（goal 自己控制重试节奏）
    private inferFunctor(term: Term, expected?: MerType, allowFreeze = true): MerType {
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
        // 跨模块：类型上下文明确时，纳入导入模块里同名同元数的类型构造子。
        // typeMap 按类型构造子键索引，直接查目标类型即可（原全表扫是 O(类型数)）
        if (expCtor) {
            const ti = this.exportManager.lookupType(expCtor)
            if (ti) collectConstrs(ti)
        }
        // 函数签名候选：限定名只看目标模块；否则本模块声明优先（遮蔽导入），
        // 本模块没有时回退全局导出索引。hasOwnFunc 区分候选是否来自本模块，
        // 供无类型上下文时的保守消歧规则使用
        const funcCands = this.funcCandidates(term)
        // 自限定名（array.m 里的 array.f）等价于无限定：候选来自本模块，
        // 不触发"限定名直取目标模块"的 qualPick 捷径，走常规消歧规则
        const selfQ = this.isSelfQualified(term.qualified)
        const hasOwnFunc = (!term.qualified || selfQ)
            && this.altsOf(this.funcAlts, name, term.semanticArity, term.arity).length > 0
        let fComputed = false
        let fCache: { sig: FuncInfo; verified: boolean } | undefined
        const pickFunc = () => {
            if (!fComputed) { fCache = this.pickSig(funcCands, term.args); fComputed = true }
            return fCache
        }

        // 被选中项的实例化类型：类型变量已按本次使用重命名（见 freshenType），
        // 与 tryUnify/unify 写入 subst 的绑定一致，供参数对齐与结果类型使用
        let instArgTypes: MerType[] | undefined
        let instResultType: MerType | undefined
        const useCI = (ci: ConsInfo) => {
            const inst = this.freshenCons(ci)
            instArgTypes = inst.argTypes
            instResultType = inst.resultType
        }
        const useFunc = (f: FuncInfo) => {
            const s = this.freshenSig(f)
            instArgTypes = s.argTypes
            instResultType = s.resultType
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
            // subst 绑定（tryUnify 失败自动回滚），且只有命中的构造子提交其合一结果
            for (const ci of constrs) {
                const inst = this.freshenCons(ci)
                if (this.tryUnify(inst.resultType, expected!, true)) {
                    chosenCI = ci
                    instArgTypes = inst.argTypes
                    instResultType = inst.resultType
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

        const resultType = instResultType
            ? applySubst(instResultType, this.subst)
            : { kind: 'var', name: this.freshVar() } as MerType
        const category = chosenCI ? 'constructor' as const : chosenFunc ? 'func' as const : undefined

        // 对齐参数类型
        const argTypes = instArgTypes?.map(a => applySubst(a, this.subst))
            ?? term.args.map(() => ({ kind: 'var', name: this.freshVar() } as MerType))
        for (let i = 0; i < term.args.length; i++) {
            this.inferTerm(term.args[i], argTypes[i])
        }
        this.inferred.set(term, { type: resultType, category, sig: chosenFunc })
        // freeze：信息不足导致的消歧失败（如 stream/4 双构造子、重载 func 实参未知），
        // 登记延迟目标——等结果类型被后续 goal 绑定（或实参类型有新进展）时重跑消歧。
        // 等价于 Mercury freeze/2：变量绑定时唤醒挂起目标。
        // 注意跨模块构造子在无类型上下文时不进 constrs（见上方 expCtor 收集条件），
        // 必须用 hasCrossConstrs 补上——否则构造子全在导入模块里时根本不挂起
        // inTrialDepth>0 时处于 trialSig 投机试解：失败会回滚 subst 但 frozen
        // 队列不会回滚，投机推断挂起的 goal 会指向已丢弃的状态 → 禁止推送；
        // frozenTerms 去重：同一项重试/嵌套试解不重复登记
        if (allowFreeze && this.inTrialDepth === 0 && !this.frozenTerms.has(term)
            && !chosenCI && !chosenFunc
            && (constrs.length > 0 || funcCands.length > 0 || this.hasCrossConstrs(name, arity))) {
            this.frozenTerms.add(term)
            let lastScore = -1
            // watch：结果类型变量 + 直接变量实参的（别名链终端）类型变量。
            // 复合实参的内部变量不挂——它们的进展由各自项的推断承担
            const watches: { t: MerType; last: string }[] = []
            const addWatch = (t: MerType | undefined) => {
                if (t?.kind === 'var') watches.push({ t, last: this.watchKey(t) })
            }
            addWatch(resultType)
            for (const a of term.args) {
                if (isVariable(a) || ['!/1', '!./1', '!:/1'].includes(a.nameArity)) {
                    const vt = this.varTypes.get(this.varKey(a))
                    const rt = vt ? applySubst(vt, this.subst) : undefined
                    // 存终端变量名：后续别名链延长时 watchKey 仍能跟随解析
                    if (rt?.kind === 'var') addWatch({ kind: 'var', name: rt.name })
                }
            }
            this.frozen.push({
                term,
                watches,
                goal: () => {
                    const resolved = applySubst(resultType, this.subst)
                    const expectedT = resolved.kind === 'ctor' ? this.resolveSynonym(resolved) : undefined
                    const knownArgs = term.args.reduce((n, a) => {
                        const t = this.quickArgType(a)
                        return n + (t && t.kind !== 'var' ? 1 : 0)
                    }, 0)
                    // 进展分：结果类型落地权重最高；实参已知类型数次之。
                    // 分数不变说明自上次重试没有新信息，跳过昂贵的重载试解
                    const score = (expectedT ? 1 << 20 : 0) + knownArgs
                    if (score === lastScore) return false
                    lastScore = score
                    if (!expectedT && knownArgs === 0) return false
                    this.inferFunctor(term, expectedT, false)
                    const after = this.inferred.get(term)
                    return !!(after?.category ?? after?.sig)
                },
            })
        }
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
            // 期望的高阶签名对闭包头/结果的约束要么整体成立、要么整体放弃：
            // 逐个 unify 会在中途失败时留下部分绑定（如第 2 个参数不匹配但第 1 个已绑定）
            const ea = expected.args
            const trial = new Map(this.subst)
            let ok = true
            for (let i = 0; i < argTypes.length && i < ea.length; i++) {
                if (!unify(argTypes[i], ea[i], trial)) ok = false
            }
            if (expected.result && !unify(resultType, expected.result, trial)) ok = false
            if (ok) this.subst = trial
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
    // 重载候选收集：同一 name/arity 的每条声明都保留（签名不同才算不同候选，
    // 重复声明同一签名去重——如 interface/implementation 两段都声明时）
    private pushAlt(map: Map<string, FuncInfo[]>, key: string, info: FuncInfo) {
        const sig = JSON.stringify({ a: info.argTypes, r: info.resultType })
        const arr = map.get(key)
        if (arr) {
            if (!arr.some(f => JSON.stringify({ a: f.argTypes, r: f.resultType }) === sig)) arr.push(info)
        } else {
            map.set(key, [info])
        }
    }
    // 实参的「已知类型」：变量查 varTypes（经 subst 解析），字面量给构造子类型；
    // 其余（复合项等尚未推断的）返回 undefined——中性，不参与消歧打分
    private quickArgType(term: Term): MerType | undefined {
        if (isVariable(term) || ['!/1', '!./1', '!:/1'].includes(term.nameArity)) {
            const t = this.varTypes.get(this.varKey(term))
            return t ? applySubst(t, this.subst) : undefined
        }
        const st = term.syntaxType
        const mk = (name: string): MerType => ({ kind: 'ctor', ctor: { name, arity: 0 }, args: [] })
        if (st === 'integer') return mk('int')
        if (st === 'float') return mk('float')
        if (st === 'string') return mk('string')
        // 复合项/函子：读已推断的类型（真实推断阶段写入），用于 hasKnown 与 frozen 进展检测
        const inferred = this.inferred.get(term)
        if (inferred?.type) {
            const t = applySubst(inferred.type, this.subst)
            return t.kind === 'var' ? undefined : t
        }
        return undefined
    }
    private countTypeVars(t: MerType): number {
        if (t.kind === 'var') return 1
        if (t.kind === 'ctor') return t.args.reduce((s, a) => s + this.countTypeVars(a), 0)
        return t.args.reduce((s, a) => s + this.countTypeVars(a), 0) + (t.result ? this.countTypeVars(t.result) : 0)
    }
    // 重载候选消歧（试解）：对每个候选签名在克隆的推断状态上完整推一遍实参，
    // 提交性合一全部成功才算可行——这是真正的合一判定，复合实参、共享类型变量、
    // 结果类型约束都自然覆盖，不是启发式打分。多个候选都成功时取类型变量最少者
    //（最具体的签名）；仍并列或全失败则返回 undefined（不猜，保持无类别）。
    // 返回 verified=true 表示该签名经过完整试解且唯一胜出（实参类型确实支持它）；
    // verified=false 仅出现在「单候选 + 实参类型全未知」的弱返回——调用方在
    // func/构造子歧义场景应据此保持无类别，而不是直接采信
    private pickSig(cands: FuncInfo[], args: Term[]): { sig: FuncInfo; verified: boolean } | undefined {
        if (cands.length === 0) return undefined
        // 试解内部不再嵌套试解：trialSig 推实参时遇到多候选重载，若再对每个
        // 候选完整试解会组合爆炸（候选数 × 嵌套深度）。投机试解里实参保持
        // 自由变量即可——变量与任何形参类型都能合一，不影响外层候选的可行性
        // 判定；胜出后正式推断在 inTrialDepth=0 下会重新做完整消歧
        if (this.inTrialDepth > 0) {
            return cands.length === 1 ? { sig: cands[0], verified: false } : undefined
        }
        // 没有任何实参带已知类型时，所有候选都会"成功"，试解无意义 → 直接歧义；
        // 仅单候选时弱返回（不试解），多候选判歧义
        const hasKnown = args.some(a => {
            const t = this.quickArgType(a)
            return !!t && t.kind !== 'var'
        })
        if (!hasKnown) {
            return cands.length === 1 ? { sig: cands[0], verified: false } : undefined
        }
        // 试算会写 inferred：先快照实参子树的条目，全部试完后回滚，
        // 由胜出候选在正式推断时重新写入（败者的类别/类型不留残渣）
        const argTerms = this.collectArgTerms(args)
        const saved = new Map<Term, InferredInfo | undefined>()
        for (const t of argTerms) saved.set(t, this.inferred.get(t))
        const successes: { sig: FuncInfo; vars: number }[] = []
        for (const c of cands) {
            // 廉价预过滤：已知类型的变量实参与候选参数先在草稿 subst 上合一，
            // 失败的候选必然过不了完整试解（inferTerm 对变量实参做的就是同样
            // 的 unify），省掉克隆状态+重推实参的开销（+/-/* 等十余个重载时显著）
            if (!this.precheckSig(c, args)) continue
            if (this.trialSig(c, args)) {
                successes.push({ sig: c, vars: c.argTypes.reduce((s, a) => s + this.countTypeVars(a), 0) })
            }
        }
        for (const [t, old] of saved) {
            if (old === undefined) this.inferred.delete(t)
            else this.inferred.set(t, old)
        }
        if (successes.length === 0) return undefined
        successes.sort((a, b) => a.vars - b.vars)
        if (successes.length > 1 && successes[1].vars === successes[0].vars) return undefined
        return { sig: successes[0].sig, verified: true }
    }
    // 收集实参子树的全部 Term 节点（pickSig 的 inferred 快照/回滚用）
    private collectArgTerms(args: Term[]): Term[] {
        const out: Term[] = []
        const walk = (t: Term) => {
            out.push(t)
            for (const a of t.args ?? []) walk(a)
        }
        for (const a of args) walk(a)
        return out
    }
    // pickSig 的廉价预检：只对「变量/状态变量且类型已知」的实参做 unify 试探
    // （inferTerm 对这类实参的失败条件与此相同）；字面量实参在 inferTerm 里
    // 不与形参类型合一、复合项类型未知，都跳过不判。全部在草稿 subst 上进行，
    // 不提交任何绑定；任一已知实参合一失败 → 该候选不可能成功。
    private precheckSig(sig: FuncInfo, args: Term[]): boolean {
        const s = this.freshenSig(sig)
        const scratch = new Map(this.subst)
        let ti = 0
        for (const arg of args) {
            const param = s.argTypes[ti]
            if (param !== undefined
                && (isVariable(arg) || ['!/1', '!./1', '!:/1'].includes(arg.nameArity))) {
                const known = this.quickArgType(arg)
                // 与 tryUnify 一致做 ground 同义词展开：known 可能是 state（io 展开后），
                // param 是声明里的 io，不展开会 unify(state, io) 误失败
                if (known && known.kind !== 'var'
                    && !unify(this.resolveGroundSynonym(known), this.resolveGroundSynonym(param), scratch)) return false
            }
            ti += this.argWidth(arg)
        }
        return true
    }
    // 候选签名试解：克隆 subst/varTypes/varMode 后完整推一遍实参，
    // 提交性合一（unifyFailed 计数）全过才算可行；状态用后恢复，
    // 由胜出候选在正式路径重跑一次提交结果。
    // 注意 inferTerm 只对「变量实参」做 expected 合一：字面量直接返回固定类型、
    // 复合项/functor 的结果类型不与形参强制合一——所以这里逐个实参补一次
    // 「推出类型 vs 形参类型」的合一，否则 uint8.+ 对 `int_expr + 1` 也"成功"，
    // 所有重载并列 → 判歧义 → hover 回退 funcMap 的任意签名
    private trialSig(sig: FuncInfo, args: Term[]): boolean {
        const sSubst = this.subst, sVarTypes = this.varTypes, sVarMode = this.varMode, sFail = this.unifyFailed
        this.subst = new Map(sSubst)
        this.varTypes = new Map(sVarTypes)
        this.varMode = new Map(sVarMode)
        this.unifyFailed = 0
        this.inTrialDepth++
        try {
            const s = this.freshenSig(sig)
            const argTypes = s.argTypes.map(a => applySubst(a, this.subst))
            let ti = 0
            for (const arg of args) {
                // 形参类型先展开同义词：inferTerm 内部对变量实参的合一与
                // 下面的返回类型检查必须用同一展开结果，否则 assoc_list 这类
                // 同义词形参会被误判不合一
                const expected = argTypes[ti] && this.resolveSynonym(argTypes[ti])
                this.markVarMode(arg, s.argModes?.[ti] ?? 'in')
                const t = this.inferTerm(arg, expected)
                ti += this.argWidth(arg)
                if (expected && !this.tryUnify(t, expected)) return false
            }
            return this.unifyFailed === 0
        } finally {
            this.subst = sSubst
            this.varTypes = sVarTypes
            this.varMode = sVarMode
            this.unifyFailed = sFail
            this.inTrialDepth--
        }
    }
    // 是否存在同名同元数的跨模块类型构造子（导出索引内）；
    // 用于无类型上下文时判断 func/构造子是否歧义
    private hasCrossConstrs(name: string, arity: number): boolean {
        return this.exportManager.hasCtor(name, arity)
    }
    // alts 表按语义元数优先、arity 兜底取候选（与 signatureOf 的双键查询一致）
    private altsOf(map: Map<string, FuncInfo[]>, name: string, sem: number, alt: number): FuncInfo[] {
        return map.get(keyOf(name, sem)) ?? map.get(keyOf(name, alt)) ?? []
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
    // goal 位置调用的签名候选：限定名只看目标模块；否则本模块声明优先（遮蔽导入），
    // 本模块没有时回退全局导出索引（偏宽，由 pickSig 的实参类型消歧兜底）
    private callCandidates(term: Term): FuncInfo[] {
        const name = term.name, sem = term.semanticArity, alt = term.arity
        if (term.qualified) {
            if (this.isSelfQualified(term.qualified)) {
                return [...this.altsOf(this.funcAlts, name, sem, alt), ...this.altsOf(this.predAlts, name, sem, alt)]
            }
            const vr = this.qualifiedModuleDoc(term.qualified)?.visitResult
            if (!vr) return []
            return [...this.altsOf(vr.funcAlts, name, sem, alt), ...this.altsOf(vr.predAlts, name, sem, alt)]
        }
        const own = [...this.altsOf(this.funcAlts, name, sem, alt), ...this.altsOf(this.predAlts, name, sem, alt)]
        if (own.length) return own
        return this.exportManager.lookupSigAlts(name, sem, alt)
    }
    // 数据位置 functor 的函数候选（构造子另行收集；pred 不进入项位置）
    private funcCandidates(term: Term): FuncInfo[] {
        const name = term.name, sem = term.semanticArity, alt = term.arity
        if (term.qualified) {
            if (this.isSelfQualified(term.qualified)) {
                // 自限定：只看本模块声明，不回退导出索引（限定名不该看到 import 的符号）
                return this.altsOf(this.funcAlts, name, sem, alt)
            }
            const vr = this.qualifiedModuleDoc(term.qualified)?.visitResult
            return vr ? this.altsOf(vr.funcAlts, name, sem, alt) : []
        }
        const own = this.altsOf(this.funcAlts, name, sem, alt)
        if (own.length) return own
        return this.exportManager.lookupFuncAlts(name, sem, alt)
    }
    // 签名/构造子类型的实例化入口：查签名后立即 freshen，保证 argTypes 与
    // resultType 共享同一组重命名后的类型变量
    private sigAt(termOrName: Term | string, arity?: number): FuncInfo | undefined {
        const sig = this.signatureOf(termOrName, arity)
        return sig && this.freshenSig(sig)
    }
    // 声明/构造子类型的实例化：把签名里所有具名类型变量（T/K/V...）重命名为
    // 子句内唯一名（`T#3`）。每次使用（每次调用、每个构造子）都是独立实例——
    // 否则不同实例共享 subst 里的同名绑定互相污染：先 `t1:int` 绑定类型参数 T
    // 后，`t2:string` 的 T 已被污染成 int 而被误拒；`q(X), q(Y)` 两次调用被
    // 强制同型（Mercury 语义里每次调用独立实例化）。`#n` 后缀由
    // merTypeToString 剥掉，hover 仍显示 T；?N 推断变量原样保留。
    private freshenType(t: MerType, map: Map<string, MerType>): MerType {
        if (t.kind === 'var') {
            // ?N 推断变量与 T#n 已实例化变量原样保留（# 在源码类型变量名中不可能出现）
            if (/^\?\d+$/.test(t.name) || t.name.includes('#')) return t
            let v = map.get(t.name)
            if (!v) {
                v = { kind: 'var', name: `${t.name}#${this.varCounter++}` }
                map.set(t.name, v)
            }
            return v
        }
        if (t.kind === 'ctor') {
            return { kind: 'ctor', ctor: t.ctor, args: t.args.map(a => this.freshenType(a, map)) }
        }
        return {
            kind: 'ho', pf: t.pf,
            args: t.args.map(a => this.freshenType(a, map)),
            result: t.result ? this.freshenType(t.result, map) : undefined,
        }
    }
    private freshenSig(sig: FuncInfo): FuncInfo {
        const map = new Map<string, MerType>()
        return {
            ...sig,
            argTypes: sig.argTypes.map(a => this.freshenType(a, map)),
            resultType: sig.resultType ? this.freshenType(sig.resultType, map) : undefined,
        }
    }
    private freshenCons(ci: ConsInfo): { argTypes: MerType[]; resultType: MerType } {
        const map = new Map<string, MerType>()
        return {
            argTypes: ci.argTypes.map(a => this.freshenType(a, map)),
            resultType: this.freshenType(ci.resultType, map),
        }
    }
    private signatureOf(termOrName: Term | string, arity?: number): FuncInfo | undefined {
        const name = typeof termOrName === 'string' ? termOrName : termOrName.name
        const a = typeof termOrName === 'string' ? arity! : termOrName.semanticArity
        // 状态变量 !X 在语义元数上按两个参数（!.X / !:X）计，但声明处常按单个逻辑参数计（如
        // `:- pred p(list(T)::out)` 配 `p(!List)`）。两种元数都查一次，兼容这种写法。
        const aAlt = typeof termOrName === 'string' ? a : termOrName.arity
        if (typeof termOrName !== 'string' && termOrName.qualified) {
            // 自限定名（本模块里的 M.f）：模块尚未注册进 moduleManager，
            // 只查本模块声明，不回退导出索引（限定名不该看到 import 的符号）
            if (this.isSelfQualified(termOrName.qualified)) {
                return this.funcs.get(keyOf(name, a)) ?? this.funcs.get(keyOf(name, aAlt))
                    ?? this.preds.get(keyOf(name, a)) ?? this.preds.get(keyOf(name, aAlt))
            }
            const doc = this.qualifiedModuleDoc(termOrName.qualified)
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
