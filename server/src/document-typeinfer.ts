/******************************************************************************
 * 构建阶段 3：clause body 的类型推导 + 名称解析（qualified）
 *
 * 从索引阶段独立拆出。推断不再随 visit 逐 clause 进行：只有等阶段 2 把
 * 所有文件的定义/import/导出标记都放进 GlobalIndex 之后，签名与类型信息才完整。
 ******************************************************************************/
import type { CancellationToken } from 'vscode-languageserver'
import type { MercuryDocument } from './document-manager'
import type { SymbolEntry } from './document-index'
import type { Clause, Term } from './term'
import {
    FuncInfo, InferredInfo, MerType, varType,
} from './document-type'
import {
    createLogicVar, resolve, useTrail,
    type LogicVar, type Logical,
} from './logical-var'
import type { GlobalIndex } from './document-index'
import { interruptAndCheck } from './promise-util'

// 声明里的签名是纯 MerType 模板（只读）；每次使用点实例化成可合一的逻辑项
type LType = Logical<MerType>
type LVar = LogicVar<MerType>
type SignatureInst = { sig: FuncInfo; args: LType[]; result?: LType }
/** 单条 clause 的推导上下文：逻辑变量与 trail 都是 clause 局部的，不留在服务实例上 */
type ClauseCtx = {
    clauseVars: Map<string, LVar>
    termVars: Map<Term, LVar>
    typeVars: Map<string, LVar>
    trail: ReturnType<typeof useTrail>
}

const isLVar = (x: unknown): x is LVar =>
    !!x && typeof x === 'object' && typeof (x as any).deref === 'function'
function isVariable(term: Term) {
    return term.syntaxType === 'variable'
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
 * 独立的类型推导器：输入是已完成全局 index 的文档，输出推断结果。
 */
export class TypeInferer {
    private index: GlobalIndex
    constructor(index: GlobalIndex) {
        this.index = index
    }

    async inferDocument(doc: MercuryDocument, cancelToken?: CancellationToken) {
        const inferred = new Map<Term, InferredInfo>()
        doc.inferred = inferred
        for (const clause of doc.parseResult.value.args) {
            if (cancelToken) await interruptAndCheck(cancelToken)
            for (const [term, v] of this.inferClause(clause as Clause)) {
                inferred.set(term, { type: resolve<MerType>(v, () => varType('?0')) })
            }
        }
    }




    /**
     * 一条 clause 的 head 推导：pred/func 的 fact/rule 参数位置变量各建一个类型
     * 逻辑变量，再与声明签名（predType/funcType）的对应字段合一。
     * 返回 term → 逻辑变量，由 inferDocument 展开后写入 doc.inferred。
     */
    private inferClause(clause: Clause): Map<Term, LVar> {
        const ctx: ClauseCtx = {
            clauseVars: new Map(),
            termVars: new Map(),
            typeVars: new Map(),
            trail: useTrail(),
        }
        const top = clause.term
        if (top.nameArity !== ':-/1') {
            let t = top
            if (t.nameArity === ':-/2') t = t.args[0] // rule：去掉 body，只留 head
            let head: Term
            let result: Term | undefined
            if (t.nameArity === '=/2') {
                head = t.args[0]                       // func fact/rule: F(Args) = Result
                result = t.args[1]
            } else if (t.nameArity === '-->/2') {
                head = t.args[0]                       // DCG head
            } else {
                head = t                               // pred fact/rule
            }
            if (head.nameArity === './2') head = head.args[1] // 限定名取右项
            const sig = this.signatureOf(head)
            const inst = sig && (sig.kind === 'pred' || sig.kind === 'func')
                ? this.instantiateSignature(head, sig, ctx)
                : undefined
            this.inferHead(head, inst, ctx)
            if (result) {
                const vterm = this.headVarTerm(result)
                if (vterm) {
                    const lv = this.varOf(vterm, ctx)
                    if (inst?.result) ctx.trail.unify(lv, inst.result)
                }
            }
        }
        return ctx.termVars
    }
    // 状态变量 !X 在解析树里只占一个参数节点，语义上却对应签名的两个字段
    //（!.X / !:X）；!.X、!:X 各占一个。按语义宽度对齐，否则 `p(A, B, C, !X, !Y)`
    // 会把 !Y 错对到第 4 个签名字段（推成 X 的类型）。
    private argWidth(term: Term): number {
        return term.nameArity === '!/1' ? 2 : 1
    }
    // 按签名字段对齐实参：!X 吃掉两个字段但只推断一次（两个字段类型相同）

    // 头签名 → 头参数类型（状态变量 !X / !.X / !:X 视为同一变量 X）
    private inferHead(head: Term, outer: SignatureInst | undefined, ctx: ClauseCtx) {
        let field = 0
        for (const arg of head.args ?? []) {
            const width = this.argWidth(arg)
            const vterm = this.headVarTerm(arg)
            if (vterm) {
                const lv = this.varOf(vterm, ctx)
                if (outer) {
                    for (let i = 0; i < width; i++) {
                        const target = outer.args[field + i]
                        if (target !== undefined) ctx.trail.unify(lv, target)
                    }
                }
            }
            field += width
        }
    }

    /** 从全局符号表取该 head 的声明签名（定义条目不带签名） */
    private signatureOf(head: Term): MerType | undefined {
        const entries: readonly SymbolEntry[] = this.index.getByName(head.name)
        for (const s of entries) {
            if ((s.kind === 'pred' || s.kind === 'func')
                && s.arity === head.semanticArity && s.signature) {
                const sig = s.signature
                if (sig.kind === head.semanticType) return sig
            }
        }
        return undefined
    }

    /** 声明签名是只读模板，实例化成可合一的逻辑项；类型变量按名字共享 */
    private instantiateSignature(head: Term, sig: MerType, ctx: ClauseCtx): SignatureInst {
        return {
            sig: { name: head.name, arity: head.semanticArity, type: sig },
            args: (sig.kind === 'pred' || sig.kind === 'func' ? sig.args : [])
                .map(a => this.instantiate(a, ctx)),
            result: sig.kind === 'func' && sig.result ? this.instantiate(sig.result, ctx) : undefined,
        }
    }

    private instantiate(type: MerType, ctx: ClauseCtx): LType {
        if (type.kind === 'var') {
            let v = ctx.typeVars.get(type.name)
            if (!v) {
                v = createLogicVar<MerType>()
                ctx.typeVars.set(type.name, v)
            }
            if (type.bind) ctx.trail.unify(v, this.instantiate(type.bind, ctx))
            return v
        }
        const out: any = { ...type }
        if ('args' in type) out.args = type.args.map(a => this.instantiate(a, ctx))
        if ('result' in type && type.result) out.result = this.instantiate(type.result, ctx)
        return out as LType
    }

    /** 同名变量共享一个逻辑变量；每个出现位置都登记，便于写回推断结果 */
    private varOf(term: Term, ctx: ClauseCtx): LVar {
        let v = ctx.clauseVars.get(term.name)
        if (!v) {
            v = createLogicVar<MerType>()
            ctx.clauseVars.set(term.name, v)
        }
        ctx.termVars.set(term, v)
        return v
    }

    /** 剥掉 ::/>> 注解与 !X / !.X / !:X 状态变量包装，取真正的参数变量 */
    private headVarTerm(arg: Term): Term | undefined {
        let t = arg
        while (t.args?.length && ['::/2', '>>/2', '!/1', '!./1', '!:/1'].includes(t.nameArity)) {
            t = t.args[0]
        }
        return isVariable(t) ? t : undefined
    }
    /** 限定调用 m:p(...) 取右项 */
    private unwrapQualifiedInfer(term: Term): Term {
        return term.nameArity === './2' ? term.args[1] : term
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

    }
    // 统一目标：rhs 类型需与 lhs 一致；lhs 若已有具体类型（来自头签名）则约束 rhs。
    // 类型是活引用，unify 后读取时自然可见，无需刷新快照。
    private inferUnify(lhs: Term, rhs: Term) {

    }



}
