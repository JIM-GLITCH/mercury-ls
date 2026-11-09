/******************************************************************************
 * 构建阶段 3：clause body 的类型推导 + 名称解析（qualified）
 *
 * 从索引阶段独立拆出。推断不再随 visit 逐 clause 进行：只有等阶段 2 把
 * 所有文件的定义/import/导出标记都放进 GlobalIndex 之后，签名与类型信息才完整。
 ******************************************************************************/
import type { CancellationToken } from 'vscode-languageserver'
import type { MercuryDocument } from './document-manager'
import type { SymbolEntry, ModuleIndex } from './document-index'
import type { Clause, Term } from './term'
import {
    ConsInfo, FuncInfo, InferredInfo, MerType, TypeCtor, TypeInfo,
    keyOf, keyOfTypeCtor,
} from './document-type'
import {
    createLogicVar, resolve, unify, useTrail,
    type LogicVar, type Logical,
} from './logical-var'
import type { GlobalIndex } from './document-index'
import { moduleQualifiedName } from './utils'
import { interruptAndCheck } from './promise-util'

// 声明里的签名是纯 MerType 模板（只读）；每次使用点实例化成可合一的逻辑项
type LType = Logical<MerType>
type LVar = LogicVar<MerType>
type SignatureInst = { sig: FuncInfo; args: LType[]; result?: LType }
type ConsInst = { ci: ConsInfo; args: LType[]; result: LType }
const isLVar = (x: unknown): x is LVar =>
    !!x && typeof x === 'object' && typeof (x as any).deref === 'function'
function isVariable(term: Term) {
    return term.syntaxType === 'variable'
}
/** 重载签名打分：具体匹配 +1，多态形参 +0.5，实参类型冲突 -1 */
function signatureScore(fi: FuncInfo, args: (MerType | undefined)[]): number {
    let score = 0
    for (let i = 0; i < Math.min(args.length, fi.argTypes.length); i++) {
        const actual = args[i]
        if (!actual) continue
        const declared = fi.argTypes[i]
        if (declared.kind === 'var') score += 0.5
        else if (actual.kind === 'ctor' && declared.kind === 'ctor'
            && (actual.ctor.name !== declared.ctor.name || actual.ctor.arity !== declared.ctor.arity)) score -= 1
        else score += 1
    }
    return score
}

// 内建算术运算符：即使工作区没有标准库声明，也能由实参类型直接推出结果类型
const NUMERIC_CTORS = new Set([
    'int', 'float', 'uint',
    'int8', 'int16', 'int32', 'int64',
    'uint8', 'uint16', 'uint32', 'uint64',
])
const BUILTIN_ARITH_OPS = new Set([
    '+', '-', '*', '/', '//', 'div', 'mod', 'rem', '**', '<<', '>>', '/\\', '\\/', 'xor',
])

/**
 * 独立的类型推导器：输入是已完成全局 index 的文档，输出写回
 * ModuleIndex.inferred（类型/类别）与 resolved（名称解析）。
 */
export class TypeInferer {
    constructor(protected readonly index: GlobalIndex) {}

    private doc!: MercuryDocument
    private vr!: ModuleIndex
    private currentClause!: Clause
    // 类型推断工作态（每个子句重置）
    private ctx = useTrail()
    private varTypes = new Map<string, LType>()
    private varNames = new WeakMap<LVar, string>()
    private varCounter = 0

    /** 推断结果写回 ModuleIndex.inferred（linker / hover 的读取点） */
    private get inferred(): Map<Term, InferredInfo> { return this.vr.inferred }
    /** 本模块全部签名：不再依赖 clause 在文件里的先后顺序 */
    private get types(): Map<string, TypeInfo> { return this.index.localTypes(this.doc) }
    private get funcs(): Map<string, FuncInfo> { return this.index.localFuncs(this.doc) }
    private get preds(): Map<string, FuncInfo> { return this.index.localPreds(this.doc) }
    /** 跨模块查询统一由全局符号表提供 */
    private get crossIndex() {
        return {
            lookupType: (k: string) => this.index.lookupType(k, this.doc),
            lookupFunc: (n: string, a: number) => this.index.lookupFunc(n, a, this.doc),
            allTypeInfos: () => this.index.externalTypeInfos(this.doc),
        }
    }

    async inferDocument(doc: MercuryDocument, cancelToken?: CancellationToken): Promise<void> {
        const vr = this.index.get(doc)!
        if (!vr) return
        this.doc = doc
        this.vr = vr
        this.recordLocalSignatures()
        for (const clause of (doc.parseResult.value as any).args as Clause[]) {
            if (cancelToken) await interruptAndCheck(cancelToken)
            this.currentClause = clause
            this.inferClause(clause)
            this.resolveClause(clause)
        }
    }

    /** 阶段 3 的 qualified 解析：定好每个引用的签名、所属模块与限定名，全部落盘 */
    private resolveClause(clause: Clause): void {
        const top = clause.term
        const vr = this.vr
        const walk = (t: Term) => {
            if (!t) return
            if (t.syntaxType === 'atom' && t.name) {
                const entries = this.index.resolve(t, this.doc)
                const key = keyOf(t.name, t.semanticArity)
                const local = vr.funcs.get(key) ?? vr.preds.get(key)
                const picked = local
                    ? { fi: local, entry: undefined as SymbolEntry | undefined }
                    : this.pickSignature(t, entries)
                if (picked?.fi) vr.signatures.set(t, picked.fi)
                const explicit = t.qualified ? moduleQualifiedName(t.qualified) : undefined
                const owner = explicit || picked?.entry?.module
                    || (picked?.fi ? vr.moduleName : undefined)
                    || entries[0]?.module || vr.moduleName
                if (owner) t.qualifiedName = `${owner}.${t.name}`
                if (entries.length) {
                    const best = picked?.entry
                    vr.resolved.set(t, best ? [best, ...entries.filter(e => e !== best)] : entries)
                }
            }
            for (const a of t.args ?? []) walk(a)
        }
        // 规则体 / DCG 体；函数事实的右端表达式同样是 body 位置
        if (top.nameArity === ':-/2' || top.nameArity === '-->/2') walk(top.args[1])
        else if (top.nameArity === '=/2') walk(top.args[1])
    }
    /** 本模块声明/定义项：签名直接来自本模块索引，无需消歧 */
    private recordLocalSignatures(): void {
        const vr = this.vr
        const put = (t: Term) => {
            const fi = vr.funcs.get(keyOf(t.name, t.semanticArity))
                ?? vr.preds.get(keyOf(t.name, t.semanticArity))
            if (fi) vr.signatures.set(t, fi)
        }
        vr.definition.forEach(put)
        vr.declaration.forEach(put)
    }
    /** 跨模块重载：按实参推断类型选出唯一签名及其所属符号，无法消歧则不选 */
    private pickSignature(term: Term, entries: SymbolEntry[]): { fi: FuncInfo; entry: SymbolEntry } | undefined {
        if (!entries.length) return undefined
        const args = term.args.map(a => this.inferred.get(a)?.type)
        const scored = entries.map((s, i) => ({ s, i, fi: this.signatureOfEntry(s) }))
        if (!args.some(a => !!a)) {
            return scored.length === 1 && scored[0].fi
                ? { fi: scored[0].fi, entry: scored[0].s } : undefined
        }
        const ranked = scored
            .map(x => ({ ...x, score: x.fi ? signatureScore(x.fi, args) : 0 }))
            .sort((a, b) => b.score - a.score || a.i - b.i)
        const best = ranked[0]
        if (!best.fi || best.score <= 0) return undefined
        if (ranked.length > 1 && ranked[1].score === best.score) return undefined
        return { fi: best.fi, entry: best.s }
    }
    private signatureOfEntry(s: SymbolEntry): FuncInfo | undefined {
        const vr = this.index.get(s.doc)!
        return vr?.funcs.get(keyOf(s.name, s.arity)) ?? vr?.preds.get(keyOf(s.name, s.arity))
    }

    // ===== 子句级类型推断（自下而上合一，供 linker 用类型消歧 functor/func）=====
    // 设计：复用编译器同构数据流——头签名推导头变量类型，再沿 body 目标/数据项
    // 自下而上合一；重载（func+构造子同名同元数）在类型上下文能唯一确定时消歧，
    // 否则保持无类别（不标注），避免误标。推断失败不应影响索引/labeling。
    // 声明签名是模板；每个头/调用点/构造子候选各实例化一套逻辑变量，互不污染。
    private freshLogical(name?: string): LVar {
        const v = createLogicVar<MerType>()
        this.varNames.set(v, name ?? this.freshVar())
        return v
    }
    // MerType 模板 → 逻辑项：同名类型变量在一次实例化内共享同一个变量
    private instantiate(t: MerType, env: Map<string, LType> = new Map()): LType {
        const go = (x: MerType): LType => {
            if (x.kind === 'var') {
                let v = env.get(x.name)
                if (!v) { v = this.freshLogical(x.name); env.set(x.name, v) }
                return v
            }
            if (x.kind === 'ctor') {
                return { kind: 'ctor', ctor: x.ctor, args: x.args.map(go) } as LType
            }
            // ho 恒带 result（pred 用自由变量占位），保证结构合一两侧键集合一致
            return {
                kind: 'ho', pf: x.pf, args: x.args.map(go),
                result: x.result ? go(x.result) : this.freshLogical(),
            } as LType
        }
        return go(t)
    }
    private instantiateSignature(sig: FuncInfo): SignatureInst {
        const env = new Map<string, LType>()
        return {
            sig,
            args: sig.argTypes.map(a => this.instantiate(a, env)),
            result: sig.resultType ? this.instantiate(sig.resultType, env) : undefined,
        }
    }
    private instantiateCons(ci: ConsInfo): ConsInst {
        const env = new Map<string, LType>()
        return {
            ci,
            args: ci.argTypes.map(a => this.instantiate(a, env)),
            result: this.instantiate(ci.resultType, env),
        }
    }
    private unifyTypes(a: LType, b: LType): boolean {
        // 两个自由变量相遇时，让 fresh 变量链到声明里的具名类型变量，
        // 否则 hover 上的 K/V/T 会被后续推断的 ?N 冲成 unknown。
        let x = a, y = b
        if (isLVar(a) && isLVar(b) && !(a as any).bound && !(b as any).bound) {
            const na = this.varNames.get(this.chainVar(a)) ?? ''
            const nb = this.varNames.get(this.chainVar(b)) ?? ''
            const fresh = (n: string) => /^\?\d+$/.test(n)
            // 库把第一个变量链到第二个；链尾即最终显示的名字
            if (!fresh(na) && fresh(nb)) { x = b; y = a }
        }
        // 类型推断需要纯树结果：打开 occurs check，避免产生自引用类型
        return unify<MerType>(x, y, this.ctx.trail, true)
    }
    // 逻辑项当前可观察的结构；未绑定变量没有结构信息
    private peek(t: LType | undefined): any {
        let x: any = t
        const seen = new Set<any>()
        while (x && typeof x === 'object' && typeof x.deref === 'function') {
            if (seen.has(x)) return undefined
            seen.add(x)
            x = x.deref()
        }
        return x
    }
    // 未绑定变量链的链尾变量（绑定方向决定了最终显示哪个名字）
    private chainVar(v: any): any {
        let cur = v
        const seen = new Set<any>()
        while (cur && typeof cur === 'object' && typeof cur.deref === 'function' && !cur.bound) {
            if (seen.has(cur)) break
            seen.add(cur)
            const next = cur.value
            if (next && typeof next === 'object' && typeof next.deref === 'function') { cur = next; continue }
            break
        }
        return cur
    }
    // 声明的类型变量显示原名，fresh 变量显示 unknown
    private freeName(v: any): string {
        return this.varNames.get(this.chainVar(v)) ?? this.freshVar()
    }
    // 展开成不含逻辑变量的 MerType；自由变量按链尾名字还原
    private solidify(t: LType): MerType {
        return resolve<MerType>(t, v => ({ kind: 'var', name: this.freeName(v) }))
    }
    /** inferred 只持有活的逻辑项，不冻结；读取时才 resolve，后到的绑定自动可见 */
    private inferredInfo(t: LType, extra: { category?: InferredInfo['category'] } = {}): InferredInfo {
        const inferer = this
        return {
            get type(): MerType { return inferer.solidify(t) },
            category: extra.category,
        }
    }
    private inferClause(clause: Clause) {
        const top = clause.term
        // 声明（:-/1）与 DCG（-->/2）不做子句级推断
        if (top.nameArity === ':-/1' || top.nameArity === '-->/2') return
        if (!clause.callee) return
        // varNames / varCounter 保持实例级：变量名在读取时才用到，不能被后续子句清掉
        this.ctx = useTrail()
        this.varTypes = new Map()
        try {
            if (top.nameArity === ':-/2') {
                this.inferHead(top.args[0])
                this.inferGoal(top.args[1])
            } else if (top.nameArity === '=/2') {
                // 函数事实 `F(...) = Expr`：结果按返回类型推断；头参数按签名
                const sig = this.signatureOf(clause.callee)
                const inst = sig ? this.instantiateSignature(sig) : undefined
                if (sig && inst) {
                    if (inst.result) this.inferTerm(top.args[1], inst.result)
                }
                // 头与结果共用同一份签名实例，保证 f(T) = T 的类型变量一致
                this.inferHead(top.args[0], inst)
            } else {
                // 谓词事实：仅头
                this.inferHead(top)
            }
        } catch {
            // 推断异常不向外抛，保持索引稳定
        }
    }
    // 状态变量 !X 在解析树里只占一个参数节点，语义上却对应签名的两个字段
    //（!.X / !:X）；!.X、!:X 各占一个。按语义宽度对齐，否则 `p(A, B, C, !X, !Y)`
    // 会把 !Y 错对到第 4 个签名字段（推成 X 的类型）。
    private argWidth(term: Term): number {
        return term.nameArity === '!/1' ? 2 : 1
    }
    // 按签名字段对齐实参：!X 吃掉两个字段但只推断一次（两个字段类型相同）
    private inferSignatureArgs(args: Term[], inst: SignatureInst) {
        let ti = 0
        for (const arg of args) {
            this.inferTerm(arg, inst.args[ti])
            ti += this.argWidth(arg)
        }
    }
    // 头签名 → 头参数类型（状态变量 !X / !.X / !:X 视为同一变量 X）
    private inferHead(head: Term, outer?: SignatureInst) {
        // 带体的函数子句 `f(A1..An) = R :- Body`：头是 =(f(A1..An), R)，
        // 参数按签名推断，结果变量 R 按返回类型推断
        if (head.nameArity === '=/2') {
            const call = head.args[0]
            const sig = this.signatureOf(call)
            if (sig) {
                const inst = outer ?? this.instantiateSignature(sig)
                this.inferSignatureArgs(call.args, inst)
                if (inst.result) this.inferTerm(head.args[1], inst.result)
                return
            }
            // `X = Expr` 形式的头（少见）：两侧按统一推断
            this.inferUnify(head.args[0], head.args[1])
            return
        }
        const sig = this.signatureOf(head)
        if (!sig) return
        this.inferSignatureArgs(head.args, outer ?? this.instantiateSignature(sig))
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
                const resolved = calleeType ? this.peek(calleeType) : undefined
                let hoArgs: LType[]
                if (resolved && resolved.kind === 'ho' && resolved.args.length === n) {
                    hoArgs = resolved.args
                } else {
                    hoArgs = Array.from({ length: n }, () => this.freshLogical() as LType)
                    const freshHo = {
                        kind: 'ho', pf: 'pred', args: hoArgs, result: this.freshLogical(),
                    } as LType
                    if (calleeType) this.unifyTypes(calleeType, freshHo)
                    else {
                        const v = this.freshLogical()
                        this.varTypes.set(calleeKey, v)
                        this.unifyTypes(v, freshHo)
                    }
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
        this.inferSignatureArgs(term.args, this.instantiateSignature(sig))
    }
    // 统一目标：rhs 类型需与 lhs 一致；lhs 若已有具体类型（来自头签名）则约束 rhs。
    // 类型是活引用，unify 后读取时自然可见，无需刷新快照。
    private inferUnify(lhs: Term, rhs: Term) {
        const lt = this.inferTerm(lhs)
        const rt = this.inferTerm(rhs, lt)
        this.unifyTypes(lt, rt)
    }
    private pushVarType(term: Term, t: LType) {
        const key = this.varKey(term)
        // 状态变量外层节点（!X / !.X / !:X）不在 varMap 里，parser 只收了内层 X；
        // 以前只写外层节点，hover 落在内层 X 上就只看到后续推断覆盖出的 unknown。
        const varMap = term.clause?.varMap ?? this.currentClause?.varMap
        const occurrences = varMap?.get(key) ?? []
        const info = this.inferredInfo(t)
        this.inferred.set(term, info)
        for (const occ of occurrences) this.inferred.set(occ, info)
    }
    // 项/变量 → 逻辑类型（数据位置）；状态变量映射到底层变量名
    private inferTerm(term: Term, expected?: LType): LType {
        if (isVariable(term) || ['!/1', '!./1', '!:/1'].includes(term.nameArity)) {
            const key = this.varKey(term)
            let t = this.varTypes.get(key)
            if (!t) { t = this.freshLogical(); this.varTypes.set(key, t) }
            if (expected) this.unifyTypes(t, expected)
            this.pushVarType(term, t)
            return t
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
            this.inferred.set(term, this.inferredInfo(t))
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
    private inferList(term: Term, expected?: LType): LType {
        let elemType: LType = this.freshLogical()
        // 展开类型同义词：assoc_list(K,V) == list(pair(K,V)) → 取 list 元素类型 pair(K,V)
        if (expected) {
            const resolved = this.peek(this.resolveSynonym(expected))
            if (resolved && resolved.kind === 'ctor' && resolved.ctor.name === 'list' && resolved.args.length === 1) {
                elemType = resolved.args[0]
            }
        }
        const listType = (): LType => ({
            kind: 'ctor', ctor: { name: 'list', arity: 1 }, args: [elemType],
        } as LType)
        const walk = (t: Term) => {
            if (t.nameArity === '[]/0') {
                // 空表也是 list 的构造子
                this.inferred.set(t, this.inferredInfo(listType(), { category: 'constructor' }))
                return
            }
            if (t.nameArity === '[|]/2') {
                // [|]/2 恒为 list 的 cons 构造子（Mer 无法重定义）
                this.inferred.set(t, this.inferredInfo(listType(), { category: 'constructor' }))
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
        this.inferred.set(term, this.inferredInfo(result, { category }))
        return result
    }
    // 展开类型同义词（equivalence type，type T == U）：把 T(A,..) 还原为 U（代入类型参数）；
    // 本地 this.types 与跨模块全局符号表都查。非同义词原样返回。
    private resolveSynonym(t: LType): LType {
        const p = this.peek(t)
        if (!p || p.kind !== 'ctor') return t
        const ti = this.types.get(keyOfTypeCtor(p.ctor)) ?? this.crossIndex.lookupType(keyOfTypeCtor(p.ctor))
        if (!ti || !ti.body) return t
        // 同义体是模板：把类型参数映射到调用点的实参（活逻辑项），其余变量实例化
        const env = new Map<string, LType>()
        for (let i = 0; i < ti.params.length; i++) {
            const param = ti.params[i]
            if (param.kind === 'var' && p.args[i]) env.set(param.name, p.args[i])
        }
        return this.instantiate(ti.body, env)
    }
    /** 实参的自然类型：字面量直接给出，其余用已推断结果（不产生推断副作用） */
    private literalType(t: Term): MerType | undefined {
        switch (t.syntaxType) {
            case 'integer': return { kind: 'ctor', ctor: { name: 'int', arity: 0 }, args: [] }
            case 'float': return { kind: 'ctor', ctor: { name: 'float', arity: 0 }, args: [] }
            case 'string': return { kind: 'ctor', ctor: { name: 'string', arity: 0 }, args: [] }
            default: {
                const known = this.inferred.get(t)?.type
                return known && known.kind === 'ctor' ? known : undefined
            }
        }
    }
    /** 内建算术运算符：同型数值实参 → 同型结果（`1+1` 直接得到 int，不查标准库声明） */
    private builtinArithmeticType(term: Term, args: (MerType | undefined)[]): LType | undefined {
        if (term.arity === 1 && term.name === '-') {
            const a = args[0]
            return a && a.kind === 'ctor' && NUMERIC_CTORS.has(a.ctor.name) ? (a as LType) : undefined
        }
        if (term.arity !== 2 || !BUILTIN_ARITH_OPS.has(term.name)) return undefined
        const [a, b] = args
        if (!a || !b || a.kind !== 'ctor' || b.kind !== 'ctor') return undefined
        if (a.ctor.name !== b.ctor.name || a.ctor.arity !== b.ctor.arity) return undefined
        if (!NUMERIC_CTORS.has(a.ctor.name)) return undefined
        return a as LType
    }
    /**
     * 数据位置的 pred/func 部分应用一律按高阶值推导：
     * `G = g`（supplied 0，`:- pred g(int)` → pred(int)）、
     * `G = g(1)`（supplied 1，`:- pred g(int,int)` → pred(int)）。
     * 已提供的实参与签名前缀同型才采用该候选；剩余参数构成高阶值类型。
     */
    private higherOrderValue(
        term: Term, naturalArgs: (MerType | undefined)[], qualifier?: string,
    ): { type: LType; pf: 'pred' | 'func' } | undefined {
        const supplied = term.arity
        const candidates = this.index.lookupHigherOrderValue(term.name, this.doc, supplied, qualifier)
        for (const found of candidates) {
            const mark = this.ctx.mark()
            const inst = this.instantiateSignature(found.info)
            if (!this.partialArgsFit(inst, naturalArgs, supplied)) {
                this.ctx.undo(mark)
                continue
            }
            term.semanticType = found.pf
            term.semanticArity = found.info.arity
            for (let i = 0; i < term.args.length; i++) this.inferTerm(term.args[i], inst.args[i])
            return {
                pf: found.pf,
                type: {
                    kind: 'ho', pf: found.pf, args: inst.args.slice(supplied),
                    result: inst.result ?? this.freshLogical(),
                } as LType,
            }
        }
        return undefined
    }
    /** 部分应用已提供的实参须与声明签名前缀的参数类型相容，避免把同名构造子误判为高阶值 */
    private partialArgsFit(inst: SignatureInst, args: (MerType | undefined)[], n: number): boolean {
        for (let i = 0; i < n && i < inst.args.length; i++) {
            const a = args[i]
            if (!a || a.kind !== 'ctor') continue
            const p = this.peek(inst.args[i])
            if (p && p.kind === 'ctor' && (p.ctor.name !== a.ctor.name || p.ctor.arity !== a.ctor.arity)) return false
        }
        return true
    }
    /** 候选签名须与 expected 结果类型、实参自然类型一致，避免抄到不相干的重载 */
    private signatureFits(inst: SignatureInst, expected: LType | undefined, args: (MerType | undefined)[]): boolean {
        // 先做无副作用检查
        for (let i = 0; i < args.length && i < inst.args.length; i++) {
            const a = args[i]
            if (!a || a.kind !== 'ctor') continue
            const p = this.peek(inst.args[i])
            if (p && p.kind === 'ctor' && (p.ctor.name !== a.ctor.name || p.ctor.arity !== a.ctor.arity)) return false
        }
        // 再合一结果类型；成功时留下的约束正是采用该签名所需的
        if (expected && inst.result && !this.unifyTypes(inst.result, expected)) return false
        return true
    }
    // 数据位置 functor：expected 类型 + 实参自然类型 + 签名一致性消歧；
    // 无可用声明时内建算术运算符直接由实参给出结果类型
    private inferFunctor(term: Term, expected?: LType): LType {
        const name = term.name
        const arity = term.arity
        const exp = expected ? this.peek(expected) : undefined
        const expCtor: TypeCtor | undefined = exp && exp.kind === 'ctor' ? exp.ctor : undefined
        // 自下而上取实参自然类型：用于重载校验与内建运算符推导
        const naturalArgs = term.args.map(a => this.literalType(a))
        const builtinType = this.builtinArithmeticType(term, naturalArgs)
        const qualifier = term.qualified ? moduleQualifiedName(term.qualified) : undefined
        const constrs: ConsInfo[] = []
        const collectConstrs = (ti: TypeInfo) => {
            for (const ci of ti.constructors) {
                if (ci.ctor === name && ci.arity === arity) constrs.push(ci)
            }
        }
        for (const ti of this.types.values()) collectConstrs(ti)
        // 跨模块：类型上下文明确时，纳入导入模块里同名同元数的类型构造子
        if (expCtor) {
            for (const ti of this.crossIndex.allTypeInfos()) {
                if (ti.ctor.name === expCtor.name && ti.ctor.arity === expCtor.arity) collectConstrs(ti)
            }
        }
        // 构造子优先：`(>)`, `(<)`, `(=)` 这类零元构造子不能因同名 pred/func 声明
        // （如 rational.>/2）被当成部分应用的高阶值；其余数据项才按高阶值推导
        if (!constrs.length) {
            const hoValue = this.higherOrderValue(term, naturalArgs, qualifier)
            if (hoValue) {
                this.inferred.set(term, this.inferredInfo(hoValue.type, { category: hoValue.pf }))
                return hoValue.type
            }
        }
        const localFunc = this.funcs.get(keyOf(name, arity))
        const candidates = this.index.lookupFuncCandidates(name, arity, this.doc, qualifier)

        let chosenInst: ConsInst | undefined
        let funcInst: SignatureInst | undefined
        const tryFuncCandidates = (pool: FuncInfo[]) => {
            for (const f of pool) {
                const mark = this.ctx.mark()
                const inst = this.instantiateSignature(f)
                if (this.signatureFits(inst, expected, naturalArgs)) { funcInst = inst; return }
                this.ctx.undo(mark)
            }
        }
        if (qualifier && candidates.length) {
            // 限定调用只在该模块内取签名，但仍需类型一致
            tryFuncCandidates(candidates)
        } else if (expCtor) {
            // 类型上下文明确：每个构造子候选各实例化一套变量；失败由 unify 自动回滚，
            // 成功但未被采用的候选也要手动回滚，只保留第一个匹配留下的约束
            for (const ci of constrs) {
                const mark = this.ctx.mark()
                const inst = this.instantiateCons(ci)
                if (this.unifyTypes(inst.result, expected!)) {
                    if (!chosenInst) chosenInst = inst
                    else this.ctx.undo(mark)
                }
            }
            if (!chosenInst) {
                // 不再盲取全局第一条同名签名：逐个按 expected / 实参类型验证
                const pool = localFunc
                    ? [localFunc, ...candidates.filter(f => f !== localFunc)]
                    : candidates
                tryFuncCandidates(pool)
            }
        } else {
            // 类型未知：仅用本模块符号消歧；跨模块候选不引入（内建算术规则除外）
            let f: FuncInfo | undefined
            if (localFunc && constrs.length === 0) {
                f = localFunc
            } else if (!localFunc && constrs.length === 1) {
                chosenInst = this.instantiateCons(constrs[0])
            } else if (localFunc && constrs.length >= 1 && localFunc.argTypes.length === arity) {
                f = localFunc
            }
            if (f) {
                const mark = this.ctx.mark()
                const inst = this.instantiateSignature(f)
                if (this.signatureFits(inst, undefined, naturalArgs)) funcInst = inst
                else this.ctx.undo(mark)
            }
            // 其余（多构造子无 func、func+构造子但参数元数不符、跨模块仅 func）→ 内建规则或留无类别
        }

        let resultType: LType
        let category: 'constructor' | 'func' | 'pred' | undefined
        if (chosenInst) {
            resultType = chosenInst.result
            category = 'constructor'
        } else if (funcInst) {
            resultType = funcInst.result ?? builtinType ?? this.freshLogical()
            category = 'func'
        } else if (builtinType) {
            resultType = builtinType
            category = 'func'
        } else {
            resultType = this.freshLogical()
        }

        // 对齐参数类型（与结果类型共用同一份签名/构造子实例；内建运算用实参自然类型）
        const argTypes = chosenInst ? chosenInst.args
            : funcInst ? funcInst.args
            : builtinType ? term.args.map((_, i) => (naturalArgs[i] as LType | undefined) ?? this.freshLogical())
            : term.args.map(() => this.freshLogical() as LType)
        for (let i = 0; i < term.args.length; i++) {
            this.inferTerm(term.args[i], argTypes[i])
        }
        this.inferred.set(term, this.inferredInfo(resultType, { category }))
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
        const argTypes: LType[] = headVars.map(v => {
            const key = this.varKey(v)
            let t = this.varTypes.get(key)
            if (!t) { t = this.freshLogical(); this.varTypes.set(key, t) }
            return t
        })
        const resultType = this.freshLogical()
        if (expected) {
            const p = this.peek(expected)
            if (p && p.kind === 'ho') {
                const ea = p.args ?? []
                for (let i = 0; i < argTypes.length && i < ea.length; i++) {
                    this.unifyTypes(argTypes[i], ea[i])
                }
                if (p.result) this.unifyTypes(resultType, p.result)
            }
        }
        // ho 恒带 result（pred 也占位），保证与其他 ho 逻辑项键集合一致
        const hoType = { kind: 'ho', pf, args: argTypes, result: resultType } as LType
        if (resultTerm) this.inferTerm(resultTerm, resultType)
        if (bodyTerm) this.inferGoal(bodyTerm)
        this.inferred.set(term, this.inferredInfo(hoType))
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
        // 全局符号表已收齐所有文件的声明/导出标记；限定名钉死目标模块
        const qualifier = typeof termOrName !== 'string' && termOrName.qualified
            ? moduleQualifiedName(termOrName.qualified) : undefined
        return this.index.lookupSignature(name, a, this.doc, qualifier, aAlt)
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
