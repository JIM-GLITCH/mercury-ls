/** 变量属性的键；symbol 可用来声明模块私有属性，避免和用户的 key 撞名。 */
export type AttrKey = string | symbol

/** 冻结目标：返回 false 表示合一失败（连同整条 trail 一起回滚）。 */
export type BoolGoal = () => boolean

export interface LogicVar<T = unknown> {
    get bound(): boolean;
    deref(): T | undefined;
    /** 只读视图；写入请用 putAttr/delAttr，这样修改才会进 trail、可以回溯。 */
    readonly attributes: ReadonlyMap<AttrKey, unknown>;
}

/**
 * 可含逻辑变量的项：T 本身、包住整个 T 的变量、或 T 的任意（含嵌套、数组元素）
 * 属性被 LogicalVar 包住。T 由非变量实参推断；未标注变量是 LogicalVar<never>，
 * 既不注入 unknown 候选，也因 never 是 bottom 而可赋给任意 LogicalVar<X>。
 */
export type Logical<T> =
    | T
    | LogicVar<T>
    | (T extends object ? { [K in keyof T]: Logical<T[K]> } : never)

/** 默认 never = 未定型的推断洞；需要具体类型时显式写 createLogicalVar<number>()。 */
export function createLogicalVar<T = never>(): LogicVar<T> {
    return new LogicVarImpl<T>()
}

let varId = 0
let currentTrail: Trail | undefined = undefined
class LogicVarImpl<T = unknown> implements LogicVar<T> {
    id = varId++
    // value 三态：undefined = 自由变量；LogicalVarImpl = 链接到另一变量；其他 = 绑定到值。
    // bound 由链尾惰性决定，所以 A -> B -> 1 里 A 与 B 会同时表现为已绑定，
    // 不必在绑定时向链上其它变量传播 bound 状态；属性则在链接时并入链尾。
    value: T | undefined = undefined
    // 一条变量链共享链尾（root）的这一份属性表：读写都经 rootOf 委托过去，
    // 两条链合一（A -> B）时把 A 的属性并入 B，绑定值后统一唤醒。
    readonly attributes = new Map<AttrKey, unknown>()

    get bound(): boolean {
        return this.deref() !== undefined
    }

    deref(): T | undefined {
        let v: LogicVarImpl = this
        const seen = new Set<LogicVarImpl>()
        while (v.value instanceof LogicVarImpl) {
            if (seen.has(v)) return undefined
            seen.add(v)
            v = v.value
        }
        return v.value as T | undefined
    }
}

export function isUnboundLogicalVar(x: Object): x is LogicVar {
    return isUnboundVarImpl(x)
}

function isUnboundVarImpl(x: unknown): x is LogicVarImpl {
    return x instanceof LogicVarImpl && !x.bound
}

type Seen = WeakMap<object, WeakSet<object>>

interface MutableVar {
    value: unknown
}

// 一次合一里所有变量写入的撤销日志。默认每次 unify 自带一条，失败即整体撤销；
// 调用方也可复用同一条 trail，用 mark = trail.length + undo(trail, mark)
// 撤销「成功但未被采用」的试探（如重载候选筛选）。
// 属性表（Map）的写入用闭包记下旧状态，和变量绑定一起按后进先出撤销。
type TrailEntry = { v: MutableVar; value: unknown } | { undo: () => void }
export type Trail = TrailEntry[]

export function createTrail(): Trail {
    return []
}

export function undo(trail: Trail, mark = 0): void {
    for (let i = trail.length - 1; i >= mark; i--) {
        const entry = trail[i]
        if ('undo' in entry) entry.undo()
        else entry.v.value = entry.value
    }
    trail.length = mark
}

/** 省略 trail 参数时优先复用 runWithTrail/useTrail 建立的求解上下文。 */
function trailOf(trail?: Trail): Trail {
    return trail ?? currentTrail ?? createTrail()
}

function bind(v: LogicVarImpl, value: unknown, trail: Trail): boolean {
    if (value instanceof LogicVarImpl) {
        // 变量与变量合一只是链接，变量仍未实例化，冻结目标继续挂起。
        mergeAttrs(v, value, trail)
    }
    trail.push({ v, value: v.value })
    v.value = value
    // 只有绑定到非变量值时才唤醒；目标失败等价于合一失败，由调用方回滚整条 trail。
    return value instanceof LogicVarImpl ? true : wakeGoals(v, trail)
}

function rootOf(x: LogicVarImpl) {
    if (!(x.value instanceof LogicVarImpl)) {
        return x
    }
    return rootOf(x.value)
}

/** freeze/2 用的私有属性键，值是等待唤醒的目标队列。 */
const FREEZE_ATTR = Symbol('freeze')

function asImpl(v: LogicVar): LogicVarImpl {
    if (!(v instanceof LogicVarImpl)) throw new TypeError('expected a logical variable')
    return v as LogicVarImpl
}

/** 属性读写都委托给链尾，因此同一条变量链上的所有变量看到同一份属性。 */
export function getAttr(v: LogicVar, key: AttrKey): unknown {
    return rootOf(asImpl(v)).attributes.get(key)
}

/** 写入属性；旧值（含「原本不存在」）记入 trail，undo 时精确恢复。 */
export function putAttr(v: LogicVar, key: AttrKey, value: unknown, trail?: Trail): void {
    const attrs = rootOf(asImpl(v)).attributes
    const had = attrs.has(key)
    const old = attrs.get(key)
    trailOf(trail).push({ undo: () => { if (had) attrs.set(key, old); else attrs.delete(key) } })
    attrs.set(key, value)
}

export function delAttr(v: LogicVar, key: AttrKey, trail?: Trail): void {
    const attrs = rootOf(asImpl(v)).attributes
    if (!attrs.has(key)) return
    const old = attrs.get(key)
    trailOf(trail).push({ undo: () => attrs.set(key, old) })
    attrs.delete(key)
}

function restoreAttrs(attrs: Map<AttrKey, unknown>, snapshot: Map<AttrKey, unknown>): void {
    attrs.clear()
    for (const [k, v] of snapshot) attrs.set(k, v)
}

/** 两条自由变量链合一：把 from 的属性并入链尾 to（freeze 目标合并成队列）。 */
function mergeAttrs(from: LogicVarImpl, to: LogicVarImpl, trail: Trail): void {
    const src = from.attributes
    if (src.size === 0) return
    const dst = to.attributes
    const oldSrc = new Map(src)
    const oldDst = new Map(dst)
    trail.push({ undo: () => { restoreAttrs(src, oldSrc); restoreAttrs(dst, oldDst) } })
    for (const [key, value] of src) {
        if (key === FREEZE_ATTR) {
            // 同一变量内保持挂起顺序；跨链合并时链尾原有队列在前，不做全局排序。
            const waiting = (dst.get(key) as BoolGoal[] | undefined) ?? []
            const added = Array.isArray(value) ? value as BoolGoal[] : [value as BoolGoal]
            dst.set(key, [...waiting, ...added])
        } else if (!dst.has(key)) {
            // 同名普通属性以链尾已有的为准，避免后来的链静默覆盖先挂上的约束。
            dst.set(key, value)
        }
    }
    src.clear()
}

/** 绑定值后依次执行冻结目标；返回 false 让外层 unify 失败并回滚。 */
function wakeGoals(v: LogicVarImpl, trail: Trail): boolean {
    const attrs = v.attributes
    const goals = attrs.get(FREEZE_ATTR) as BoolGoal[] | undefined
    if (!goals?.length) return true
    trail.push({ undo: () => attrs.set(FREEZE_ATTR, goals) })
    attrs.delete(FREEZE_ATTR)
    for (const goal of goals) {
        if (!goal()) return false
    }
    return true
}

/**
 * freeze/2：第一个参数是逻辑变量，第二个参数是 () => boolean 目标。
 * 变量未绑定时目标挂起，等该变量（或它所在变量链）被绑定到值时唤醒；
 * 变量已绑定则立即执行。目标返回 false 视为合一失败，整条 trail 一起回滚。
 * 目标内部再调用 unify/freeze 且不传 trail 时，会复用 runWithTrail 的上下文。
 */
export function freeze(v: LogicVar, goal: BoolGoal, trail?: Trail): boolean {
    const impl = asImpl(v)
    if (!isUnboundVarImpl(impl)) return goal()
    const waiting = (getAttr(impl, FREEZE_ATTR) as BoolGoal[] | undefined) ?? []
    putAttr(impl, FREEZE_ATTR, [...waiting, goal], trail)
    return true
}

function deref(x: unknown): unknown {
    return x instanceof LogicVarImpl && x.bound ? x.deref() : x
}

function isObject(x: unknown): x is object {
    return typeof x === 'object' && x !== null
}

/** 变量 v 是否出现在 x（含 x 里已绑定变量的值）里。 */
function occursIn(v: LogicVarImpl, x: unknown, seen: WeakSet<object>): boolean {
    if (x instanceof LogicVarImpl) {
        if (rootOf(x) === rootOf(v)) return true
        const value = x.deref()
        return value !== undefined && occursIn(v, value, seen)
    }
    if (!isObject(x)) return false
    if (seen.has(x)) return false
    seen.add(x)
    for (const key of Object.keys(x)) {
        if (occursIn(v, (x as Record<string, unknown>)[key], seen)) return true
    }
    return false
}

/**
 * T 从非变量实参推断；显式写 unify<Foo> 可强制按 Foo 的结构检查。
 * occursCheck 默认关闭以允许有理树；类型推断这类需要纯树结果的场景可开启。
 */
export function unify<T>(x: Logical<T>, y: Logical<T>, trail: Trail = currentTrail ?? createTrail(), occursCheck = false) {
    const mark = trail.length
    const ok = unifyImpl(x, y, new WeakMap(), trail, occursCheck)
    if (!ok) undo(trail, mark)
    return ok
}

function unifyImpl(x: unknown, y: unknown, seen: Seen, trail: Trail, occursCheck: boolean): boolean {
    if (isUnboundVarImpl(x) && isUnboundVarImpl(y)) {
        if (x === y) return true
        const rootX = rootOf(x)
        const rootY = rootOf(y)
        if (rootX === rootY) return true
        return bind(rootX, rootY, trail)
    }
    else if (isUnboundVarImpl(x) && !isUnboundVarImpl(y)) {
        const rootX = rootOf(x)
        const value = deref(y)
        if (occursCheck && occursIn(rootX, value, new WeakSet())) return false
        return bind(rootX, value, trail)
    }
    else if (!isUnboundVarImpl(x) && isUnboundVarImpl(y)) {
        const value = deref(x)
        const rootY = rootOf(y)
        if (occursCheck && occursIn(rootY, value, new WeakSet())) return false
        return bind(rootY, value, trail)
    }
    else {
        const a = deref(x)
        const b = deref(y)
        if (a !== x || b !== y) {
            return unifyImpl(a, b, seen, trail, occursCheck)
        }
        if (!isObject(a) || !isObject(b)) {
            return a === b
        }

        let paired = seen.get(a)
        if (!paired) {
            paired = new WeakSet()
            seen.set(a, paired)
        }
        if (paired.has(b)) {
            return true
        }
        paired.add(b)

        const xa = a as Record<string, unknown>
        const yb = b as Record<string, unknown>
        const keys = Object.keys(a)
        if (keys.length !== Object.keys(b).length) return false
        for (const key of keys) {
            if (!Object.prototype.hasOwnProperty.call(b, key)) return false
            if (!unifyImpl(xa[key], yb[key], seen, trail, occursCheck)) return false
        }
        return true
    }
}

/**
 * 把式子里的逻辑变量展开成当前绑定的值，返回不含 LogicalVar 的纯数据副本。
 *
 * - 已绑定变量（含 A -> B -> 值 的变量链）递归展开，值里嵌套的变量也会继续展开；
 * - 未绑定变量替换为 free（默认 undefined，可传 null / 字符串等占位值）；
 *   free 也可传 (v) => 值，按每个自由变量分别生成占位值；
 * - 不修改原式子，也不改变变量绑定，适合在 undo 之前取快照；
 * - 对象/数组按自身可枚举属性重建（与 unify 的遍历范围一致），共享引用与环
 *   （如 A = {a: A}）按图保留，不会无限递归。
 */
export function resolve<T = unknown>(x: unknown, free: (v: LogicVar) => unknown): T
export function resolve<T = unknown>(x: unknown, free?: unknown): T
export function resolve<T = unknown>(x: unknown, free: unknown = undefined): T {
    const placeholder = typeof free === 'function'
        ? free
        : resolveImpl(free, new Map(), undefined)
    return resolveImpl(x, new Map(), placeholder) as T
}

function resolveImpl(x: unknown, memo: Map<object, unknown>, free: unknown): unknown {
    if (x instanceof LogicVarImpl) {
        const value = x.deref()
        if (value === undefined) {
            return typeof free === 'function' ? (free as (v: LogicVar) => unknown)(x) : free
        }
        return resolveImpl(value, memo, free)
    }
    if (!isObject(x)) return x
    if (memo.has(x)) return memo.get(x)

    const src = x as Record<string, unknown>
    const out: Record<string, unknown> = Array.isArray(x)
        ? new Array(x.length) as unknown as Record<string, unknown>
        : Object.create(Object.getPrototypeOf(x)) as Record<string, unknown>
    // 先登记再递归，环和共享引用都指向同一个结果对象。
    memo.set(x, out)
    for (const key of Object.keys(x)) {
        Object.defineProperty(out, key, {
            value: resolveImpl(src[key], memo, free),
            enumerable: true,
            writable: true,
            configurable: true,
        })
    }
    return out
}

/**
 * 在一条共享 trail 上运行求解过程：期间不带 trail 参数的 unify/freeze/putAttr
 * 都写进这条 trail；f 返回 false（或抛错）时整体回滚。支持嵌套，退出时恢复外层上下文。
 */
export function runWithTrail(f: () => boolean, trail: Trail = createTrail()) {
    const outer = currentTrail
    currentTrail = trail
    const mark = trail.length
    try {
        const flag = f()
        if (!flag) undo(trail, mark)
        return flag
    } catch (e) {
        undo(trail, mark)
        throw e
    } finally {
        currentTrail = outer
    }
}

/** 目标可以是 [x, y] 合一式，也可以是返回 boolean 的 thunk。 */
type Goal = [unknown, unknown] | (() => boolean)

/**
 * 把一条 trail 包成目标求解器：conj 失败时整体回滚；disj 每个分支从干净状态开始，
 * yield 之后（消费者取完当前解）再撤销该分支的绑定，适合重载候选筛选。
 * 目标执行期间建立 currentTrail 上下文，冻结目标里不带 trail 的调用共享同一条 trail。
 */
export function useTrail() {
    const trail = createTrail()
    const unifyIn = (x: unknown, y: unknown) => unify(x as Logical<unknown>, y as Logical<unknown>, trail)
    const run = (goal: Goal): boolean =>
        runWithTrail(() => Array.isArray(goal) ? unifyIn(goal[0], goal[1]) : goal(), trail)
    const conj = (...goals: Goal[]): boolean => {
        const mark = trail.length
        for (const goal of goals) {
            if (!run(goal)) { undo(trail, mark); return false }
        }
        return true
    }
    function* disj(...branches: Goal[]): Generator<boolean> {
        for (const branch of branches) {
            const mark = trail.length
            if (run(branch)) yield true
            undo(trail, mark)
        }
    }
    return {
        trail,
        unify: unifyIn,
        conj,
        disj,
        mark: () => trail.length,
        undo: (mark = 0) => undo(trail, mark),
    }
}
