export interface LogicalVar {
    get bound(): boolean;
    deref(): unknown;
}

export function createLogicalVar(): LogicalVar {
    return new LogicalVarImpl()
}

let varId = 0

class LogicalVarImpl implements LogicalVar {
    id = varId++
    // value 三态：undefined = 自由变量；LogicalVarImpl = 链接到另一变量；其他 = 绑定到值。
    // bound 由链尾惰性决定，所以 A -> B -> 1 里 A 与 B 会同时表现为已绑定，
    // 不需要在绑定时向链上其它变量传播回调或复制状态。
    value: unknown = undefined
    get bound(): boolean {
        return this.deref() !== undefined
    }
    deref(): unknown {
        let v: LogicalVarImpl = this
        const seen = new Set<LogicalVarImpl>()
        while (v.value instanceof LogicalVarImpl) {
            if (seen.has(v)) return undefined
            seen.add(v)
            v = v.value
        }
        return v.value
    }
}

export function isUnboundLogicalVar(x: Object): x is LogicalVar {
    return isUnboundVarImpl(x)
}

function isUnboundVarImpl(x: unknown): x is LogicalVarImpl {
    return x instanceof LogicalVarImpl && !x.bound
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

function bind(v: LogicalVarImpl, value: unknown, trail: Trail): void {
    trail.push({ v, value: v.value })
    v.value = value
}

function rootOf(x: LogicalVarImpl) {
    if (!(x.value instanceof LogicalVarImpl)) {
        return x
    }
    return rootOf(x.value)
}

function deref(x: unknown): unknown {
    return x instanceof LogicalVarImpl && x.bound ? x.deref() : x
}

function isObject(x: unknown): x is object {
    return typeof x === 'object' && x !== null
}

export function unify(x: Object, y: Object, trail: Trail = createTrail()): boolean {
    const mark = trail.length
    const ok = unifyImpl(x, y, new WeakMap(), trail)
    if (!ok) undo(trail, mark)
    return ok
}

function unifyImpl(x: unknown, y: unknown, seen: Seen, trail: Trail): boolean {
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
        bind(rootX, value, trail)
        return true
    }
    else if (!isUnboundVarImpl(x) && isUnboundVarImpl(y)) {
        const value = deref(x)
        const rootY = rootOf(y)
        bind(rootY, value, trail)
        return true
    }
    else {
        const a = deref(x)
        const b = deref(y)
        if (a !== x || b !== y) {
            return unifyImpl(a, b, seen, trail)
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
            if (!unifyImpl(xa[key], yb[key], seen, trail)) return false
        }
        return true
    }
}

/**
 * 把式子里的逻辑变量展开成当前绑定的值，返回不含 LogicalVar 的纯数据副本。
 *
 * - 已绑定变量（含 A -> B -> 值 的变量链）递归展开，值里嵌套的变量也会继续展开；
 * - 未绑定变量替换为 free（默认 undefined，可传 null / 字符串等占位值）；
 * - 不修改原式子，也不改变变量绑定，适合在 undo 之前取快照；
 * - 对象/数组按自身可枚举属性重建（与 unify 的遍历范围一致），共享引用与环
 *   （如 A = {a: A}）按图保留，不会无限递归。
 */
export function resolve<T = unknown>(x: unknown, free: unknown = undefined): T {
    const placeholder = resolveImpl(free, new Map(), undefined)
    return resolveImpl(x, new Map(), placeholder) as T
}

function resolveImpl(x: unknown, memo: Map<object, unknown>, free: unknown): unknown {
    if (x instanceof LogicalVarImpl) {
        const value = x.deref()
        return value === undefined ? free : resolveImpl(value, memo, free)
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
