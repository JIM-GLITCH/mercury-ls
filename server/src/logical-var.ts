export interface LogicVar<T = unknown> {
    get bound(): boolean;
    deref(): T | undefined;
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

class LogicVarImpl<T = unknown> implements LogicVar<T> {
    id = varId++
    // value 三态：undefined = 自由变量；LogicalVarImpl = 链接到另一变量；其他 = 绑定到值。
    // bound 由链尾惰性决定，所以 A -> B -> 1 里 A 与 B 会同时表现为已绑定，
    // 不需要在绑定时向链上其它变量传播回调或复制状态。
    value: T | undefined = undefined
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
export type Trail = { v: MutableVar; value: unknown }[]

export function createTrail(): Trail {
    return []
}

export function undo(trail: Trail, mark = 0): void {
    for (let i = trail.length - 1; i >= mark; i--) {
        trail[i].v.value = trail[i].value
    }
    trail.length = mark
}

function bind(v: LogicVarImpl, value: unknown, trail: Trail): void {
    trail.push({ v, value: v.value })
    v.value = value
}

function rootOf(x: LogicVarImpl) {
    if (!(x.value instanceof LogicVarImpl)) {
        return x
    }
    return rootOf(x.value)
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
export function unify<T>(x: Logical<T>, y: Logical<T>, trail: Trail = createTrail(), occursCheck = false) {
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
        bind(rootX, rootY, trail)
        return true
    }
    else if (isUnboundVarImpl(x) && !isUnboundVarImpl(y)) {
        const rootX = rootOf(x)
        const value = deref(y)
        if (occursCheck && occursIn(rootX, value, new WeakSet())) return false
        bind(rootX, value, trail)
        return true
    }
    else if (!isUnboundVarImpl(x) && isUnboundVarImpl(y)) {
        const value = deref(x)
        const rootY = rootOf(y)
        if (occursCheck && occursIn(rootY, value, new WeakSet())) return false
        bind(rootY, value, trail)
        return true
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

/** 目标可以是 [x, y] 合一式，也可以是返回 boolean 的 thunk。 */
type Goal = [unknown, unknown] | (() => boolean)

/**
 * 把一条 trail 包成目标求解器：conj 失败时整体回滚；disj 每个分支从干净状态开始，
 * yield 之后（消费者取完当前解）再撤销该分支的绑定，适合重载候选筛选。
 */
export function useTrail() {
    const trail = createTrail()
    const unifyIn = (x: unknown, y: unknown) => unify(x as Logical<unknown>, y as Logical<unknown>, trail)
    const run = (goal: Goal): boolean =>
        Array.isArray(goal) ? unifyIn(goal[0], goal[1]) : goal()
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

