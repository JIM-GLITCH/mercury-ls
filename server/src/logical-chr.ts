/******************************************************************************
 * CHR 求解引擎（ω_r 精化操作语义的实用子集）
 *
 * - 实现了状态 ⟨A, S, B, T⟩ₙ 里的 A（execution stack，栈顶 = active constraint）、
 *   S（store，已 Default 的 passive 约束）、T（propagation history）、n（编号计数器）。
 *   B（built-in store）由 logical-var.ts 的 LogicVar 绑定图 + trail 承载；Solve 是外部 unify，
 *   B 的变化经 freeze 目标唤醒 CHR（Reactivate），不需要另建通知层。
 * - rules 在创建时一次给定、运行期不变，也不进 trail；按规则顺序 × head 顺序展开成 occurrence 列表。
 * - add 对应 Activate：约束编号压栈，按 occurrence 逐个尝试；伙伴只从 S 取且编号更小。
 *   全部 occurrence 无命中则 Default 入 S；栈空即求解结束，此时没有 active constraint。
 * - Default 时给约束里的自由变量挂 freeze：变量绑定到值（含变量链合并后的链尾绑定）时唤醒，
 *   把该约束重新压栈、清掉相关 propagation history，重新尝试 occurrence（Reactivate）。
 * - simplification/simpagation 删除 removed head，propagation 靠 T 避免同一组 head 重复触发；
 *   body 产生的新约束压栈深度优先处理；head 匹配用对称 unify。
 * - store / propagation history 的写入进 trail 可回滚；execution stack 只是执行游标，不整体进 trail
 *   （add/remove 的 undo 会顺带清理栈里的对应条目，Default / Reactivate 这两步不回滚）。
 * - maxSteps 是工程兜底：ω_r 不保证终止。
 ******************************************************************************/
import {
    parseRuleArray,
    type CHROperator, type RuleKindOfArray, type ValidateRuleArray,
} from './chr-rule-syntax'
import {
    createLogicVar, createTrail, freeze, isLogicalVar, resolve,
    runWithTrail, undo, unify, type LogicVar, type Trail
} from './logical-var'

/** 约束：term 可以是任意值；id 是 ω_r 状态里的编号，用于 propagation history。 */
export interface Constraint<T = unknown> {
    readonly id: number
    term: T
}

interface RuleCommon<T> {
    name: string
    /** guard 失败只算规则不适用，本次尝试连 guard 里的 unify 副作用一起回滚。 */
    guard?: (chr: CHR<T>) => boolean
    /** 返回要压栈的新约束；void/[] 表示不产生新约束。 */
    body?: (chr: CHR<T>) => T[] | void
}

/** CHR 的三种规则；字段直接对应 CHR 语法里的头部。 */
export type Rule<T = unknown> =
    | (RuleCommon<T> & { kind: 'simplification'; heads: T[] })
    | (RuleCommon<T> & { kind: 'propagation'; heads: T[] })
    | (RuleCommon<T> & { kind: 'simpagation'; kept: T[]; removed: T[] })

/** 规则工厂；每次应用生成一份 fresh rename 的规则实例（占位符变量重新创建）。 */
export type RuleFactory<T = unknown> = () => Rule<T>

function headsOf<T>(inst: Rule<T>): { kept: T[]; removed: T[] } {
    if (inst.kind === 'simpagation') return { kept: inst.kept, removed: inst.removed }
    return inst.kind === 'propagation'
        ? { kept: inst.heads, removed: [] }
        : { kept: [], removed: inst.heads }
}

interface Occurrence {
    ruleIndex: number
    headIndex: number
}

interface StackEntry<T> {
    c: Constraint<T>
    /** 下一个要尝试的 occurrence 下标。 */
    occ: number
}

export class CHR<T = unknown> {
    /** ω_r 的 S：已 Default 的 passive 约束；请用 add/remove 修改以便回溯。 */
    readonly store: Constraint<T>[] = []
    /** 静态规则程序，创建时固定、运行期不变、不进 trail。 */
    readonly rules: readonly RuleFactory<T>[]
    readonly trail: Trail = createTrail()
    /** ω_r 的 T：已触发过的规则实例 (ruleIndex, head ids)。 */
    private readonly fired = new Set<string>()
    /** ω_r 的 A：execution stack，栈顶是 active constraint。 */
    private readonly stack: StackEntry<T>[] = []
    /** 按规则顺序 × head 顺序展开的 occurrence 列表。 */
    private readonly occurrences: Occurrence[] = []
    /** ω_r 的 n：本实例自己的下一个约束编号。 */
    private nextId = 0
    /** 求解中：body 里调用 add 时只压栈，不嵌套求解。 */
    private settling = false

    constructor(rules: readonly RuleFactory<T>[] = []) {
        this.rules = [...rules]
        for (let r = 0; r < rules.length; r++) {
            const inst = rules[r]()
            const { kept, removed } = headsOf(inst)
            const n = kept.length + removed.length
            for (let i = 0; i < n; i++) this.occurrences.push({ ruleIndex: r, headIndex: i })
        }
    }

    /** ω_r 的 Activate：新约束编号后压栈，随后排空栈。 */
    add(term: T): Constraint<T> {
        const c: Constraint<T> = { id: this.nextId++, term }
        this.trail.push({ undo: () => {
            const i = this.store.indexOf(c)
            if (i >= 0) this.store.splice(i, 1)
            const j = this.stack.findIndex(e => e.c === c)
            if (j >= 0) this.stack.splice(j, 1)
        } })
        this.stack.push({ c, occ: 0 })
        this.settle()
        return c
    }

    /** 从 S 或 A 删除一条约束；undo 恢复到原位置。 */
    remove(c: Constraint<T>): void {
        const i = this.store.indexOf(c)
        if (i >= 0) {
            this.trail.push({ undo: () => this.store.splice(i, 0, c) })
            this.store.splice(i, 1)
            return
        }
        const j = this.stack.findIndex(e => e.c === c)
        if (j >= 0) {
            const entry = this.stack[j]
            this.trail.push({ undo: () => this.stack.splice(j, 0, entry) })
            this.stack.splice(j, 1)
        }
    }

    /** 尝试当前 active 约束在某个 occurrence 上的一次规则应用；伙伴只从 S 取。 */
    private tryOccurrence(top: StackEntry<T>): boolean {
        const occ = this.occurrences[top.occ]
        return runWithTrail(() => {
            const inst = this.rules[occ.ruleIndex]()
            const { kept, removed } = headsOf(inst)
            const patterns = [...kept, ...removed]
            const chosen: (Constraint<T> | undefined)[] = new Array(patterns.length)
            const activeIndex = occ.headIndex
            // 标准 CHR：head 与约束做对称合一，规则变量与 store 侧变量都可能被绑定；
            // 绑定写进 chr.trail，规则不适用时由 runWithTrail / 逐层 undo 回滚。
            if (!unify<any>(patterns[activeIndex], top.c.term, this.trail)) return false
            chosen[activeIndex] = top.c

            const search = (i: number): boolean => {
                if (i === patterns.length) {
                    const key = `${occ.ruleIndex}:${chosen.map(c => c!.id).join(',')}`
                    if (inst.kind === 'propagation' && this.fired.has(key)) return false
                    if (inst.guard && !inst.guard(this)) return false
                    const produced = inst.body?.(this)
                    const terms = Array.isArray(produced) ? produced : []
                    if (inst.kind === 'propagation') {
                        this.trail.push({ undo: () => this.fired.delete(key) })
                        this.fired.add(key)
                    }
                    for (const c of chosen.slice(kept.length)) if (c) this.remove(c)
                    // ω_r：body 的新约束压栈，成为下一个 active constraint（深度优先）。
                    for (const term of terms) this.add(term)
                    return true
                }
                if (i === activeIndex) return search(i + 1)
                for (const c of this.store) {
                    // ω_r：伙伴是更早进入 S 的约束，编号必然小于 active。
                    if (c.id >= top.c.id || chosen.includes(c)) continue
                    const mark = this.trail.length
                    if (!unify<any>(patterns[i], c.term, this.trail)) continue
                    chosen[i] = c
                    if (search(i + 1)) return true
                    chosen[i] = undefined
                    undo(this.trail, mark)
                }
                return false
            }
            return search(0)
        }, this.trail)
    }

    /** Default 时给约束里的自由变量挂 freeze：B 变化唤醒后把约束重新激活。 */
    private watch(c: Constraint<T>): void {
        const seen = new Set<object>()
        const goal = (): boolean => { this.reactivate(c); return true }
        const scan = (x: unknown): void => {
            if (isLogicalVar(x)) {
                if (seen.has(x)) return
                seen.add(x)
                // 已绑定变量不会再被唤醒；但它绑定的值里可能还嵌着自由变量。
                if (!x.bound) freeze(x, goal, this.trail)
                else scan(x.deref())
                return
            }
            if (typeof x !== 'object' || x === null || seen.has(x)) return
            seen.add(x)
            for (const key of Object.keys(x)) scan((x as Record<string, unknown>)[key])
        }
        scan(c.term)
    }

    /** ω_r 的 Reactivate：把 S 里受 B 变化影响的约束变回 active，重新尝试全部 occurrence。 */
    private reactivate(c: Constraint<T>): void {
        if (this.stack.some(e => e.c === c)) return
        const i = this.store.indexOf(c)
        if (i < 0) return
        // 与 Default 同为执行状态迁移，不入 trail；试探回滚后会在后续轮次重新 Default。
        this.store.splice(i, 1)
        this.stack.push({ c, occ: 0 })
        // 涉及它的 propagation history 失效，允许规则重新触发；规则尝试失败时随 trail 回滚。
        for (const key of [...this.fired]) {
            const ids = key.slice(key.indexOf(':') + 1).split(',')
            if (!ids.includes(String(c.id))) continue
            this.trail.push({ undo: () => { this.fired.add(key) } })
            this.fired.delete(key)
        }
        if (!this.settling) this.settle()
    }

    /** 排空 execution stack 即求解结束；add 已自动调用，显式调用是幂等的。 */
    solve(maxSteps = 100000): boolean {
        return this.settle(maxSteps)
    }

    /** ω_r 主循环：Activate → occurrence 逐个尝试 → Default → 栈空。
     *  maxSteps 是工程兜底（ω_r 不保证终止）；重入时由外层循环负责。 */
    private settle(maxSteps = 100000): boolean {
        if (this.settling) return true
        this.settling = true
        try {
            let steps = 0
            while (this.stack.length) {
                if (++steps > maxSteps) return false
                const top = this.stack[this.stack.length - 1]
                if (top.occ >= this.occurrences.length) {
                    // Default：所有 occurrence 都试过，约束进入 S 变成 passive，并观察其中的自由变量。
                    this.stack.pop()
                    this.store.push(top.c)
                    this.watch(top.c)
                    continue
                }
                if (this.tryOccurrence(top)) {
                    // active 未被删除时推进 occurrence，避免同一位置反复尝试。
                    const pending = this.stack.find(e => e.c === top.c)
                    if (pending) pending.occ++
                } else {
                    top.occ++
                }
            }
            return true
        } finally {
            this.settling = false
        }
    }
}

/** 规则集在创建时一次给定；不传规则时得到一个纯约束容器。 */
export function createCHR<T = unknown>(
    rules: readonly RuleFactory<T>[] = []
): CHR<T> {
    return new CHR<T>(rules)
}

let ruleNo = 0

/******************************************************************************
 * 语法解析见 chr-rule-syntax.ts：const A 保留数组元组与字面量 token，ParseRuleArray 在
 * 编译期检查 token 顺序 / 约束段形状并推导 kind；运行时只切段，不校验、不抛错。
 ******************************************************************************/

/** 规则工厂带上类型层推导出的规则种类。 */
export type TypedRuleFactory<K extends CHROperator, T = any> = RuleFactory<T> & { readonly kind: K }

/******************************************************************************
 * 数组骨架定义 CHR 规则：token 是字符串字面量，约束用 [...] 包成一组，值直接内联：
 *
 *   CHR_Rule(['name', '@', ['a'], '\\', ['c'], '<=>', ['b']])   simpagation
 *   CHR_Rule([['a', 'b'], '<=>', ['c']])                        simplification，省略名字
 *   CHR_Rule(['name', '@', ['a'], '==>', ['b']])                propagation
 *   CHR_Rule([['a'], '<=>', () => true, '|', ['b']])            带 guard
 *   CHR_Rule(() => {                                             工厂写法，变量在内部创建
 *     const A = createLogicVar<number>()
 *     return [[{ a: A }], '==>', () => A.deref() === 7, '|', [{ hit: A }]] as const
 *   })
 *
 * - 规则名与 '@' 可整个省略；guard 省略时 '|' 一起省略，op 后直接是 body；不写 body
 *   表示不产生新约束。body 段恰好只有一个函数时作为自定义 body。
 * - 非法 token 顺序、缺 op、'\' 配 '==>'、guard 不是函数等都是编译期错误（TS2345）。
 * - 两种写法，都没有 env：
 *   1) 数组模板：term 里的 LogicVar 只当占位符，每次规则应用 fresh rename，
 *      同一占位符在 head 与 body 之间映射到同一个新变量；guard / 自定义 body 直接
 *      写 () => boolean / (chr) => T[] 即可，不再需要通过 env 查询捕获值。
 *   2) 工厂函数：CHR_Rule(() => { const A = createLogicVar(); return [...] as const })。
 *      每次规则应用重新调用工厂，head / guard / body 共享本次新建的变量，
 *      guard 里直接 A.deref() 就是本次匹配到的值。需要读捕获变量时用这种写法。
 *      工厂返回值要 as const，否则 token 字面量被宽化，编译期校验失效。
 * - head 匹配用对称 unify：规则变量与 store 侧变量都可能被绑定，未采用的组合由 trail 回滚；
 *   body 项在规则应用时按当前绑定展开成值，自由变量保持为变量对象。
 ******************************************************************************/
export function CHR_Rule<const A extends readonly unknown[]>(
    src: A & ValidateRuleArray<A>
): TypedRuleFactory<RuleKindOfArray<A>>
export function CHR_Rule<const A extends readonly unknown[]>(
    factory: () => A & ValidateRuleArray<A>
): TypedRuleFactory<RuleKindOfArray<A>>
export function CHR_Rule(
    src: readonly unknown[] | (() => readonly unknown[])
): any {
    const factory = typeof src === 'function' ? src : undefined
    const shape = parseRuleArray(factory ? factory() : (src as readonly unknown[]))
    const name = shape.name || `rule@${ruleNo++}`
    const kind = shape.kind

    /** 把切好的骨架转成规则实例；inst 只负责把模板变量换成 fresh 变量。 */
    const build = (
        s: ReturnType<typeof parseRuleArray>,
        inst: (term: unknown) => unknown
    ): Rule<any> => {
        const kept = s.kept.map(inst)
        const removed = s.removed.map(inst)
        const bodies = s.bodies.map(inst)
        const guard = s.guard as ((chr: CHR<any>) => boolean) | undefined
        const customBody = s.customBody as ((chr: CHR<any>) => any[] | void) | undefined
        // body 段要等规则应用时才展开：此时 head 匹配已经把变量绑定好。
        // resolve 自行解引用已绑定变量，free 变量经 v => v 原样保留。
        const body = (chr: CHR<any>): any[] | void =>
            customBody
                ? customBody(chr)
                : bodies.map(term => resolve<any>(term, v => v))
        return kind === 'simpagation'
            ? { kind: 'simpagation', name, kept, removed, guard, body }
            : kind === 'propagation'
                ? { kind: 'propagation', name, heads: kept, guard, body }
                : { kind: 'simplification', name, heads: [...kept, ...removed], guard, body }
    }

    const instantiate = (): Rule<any> => {
        // 工厂写法：每次应用重新调用工厂，head / guard / body 共享本次新建的变量。
        if (factory) return build(parseRuleArray(factory()), x => x)

        // 数组模板：每次应用重建一份规则实例，同一占位符映射到同一个 fresh 变量。
        const renames = new Map<LogicVar, LogicVar>()
        const freshSet = new Set<LogicVar>()
        const renameVar = (v: LogicVar): LogicVar => {
            if (freshSet.has(v)) return v
            let fresh = renames.get(v)
            if (!fresh) {
                fresh = createLogicVar<any>()
                renames.set(v, fresh)
                freshSet.add(fresh)
            }
            return fresh
        }
        return build(shape, term => resolve(term, renameVar))
    }
    return Object.assign(instantiate, { kind })
}
