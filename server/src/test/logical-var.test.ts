import { describe, expect, it } from 'vitest'
import {
  createLogicalVar, createTrail, delAttr, freeze, getAttr, isUnboundLogicalVar,
  putAttr, resolve, runWithTrail, undo, unify, useTrail,
} from '../logical-var'


describe('unify / variable binding', () => {
  it('A', () => {
    const A = createLogicalVar()
    expect(A.bound).toBe(false)
  })
  it('A = 1', () => {
    const A = createLogicalVar()
    const flag = unify(A, 1)
    expect(flag).toBe(true)
    expect(A.bound).toBe(true)
    expect(A.deref()).toBe(1)
  })
  it('A = B', () => {
    const A = createLogicalVar()
    const B = createLogicalVar()
    const flag = unify(A, B)
    expect(flag).toBe(true)
    expect(A.bound).toBe(false)
    expect(B.bound).toBe(false)
  })
  it('A = B ,C = D ,B = C,D = 1', () => {
    const A = createLogicalVar()
    const B = createLogicalVar()
    const C = createLogicalVar()
    const D = createLogicalVar()
    unify(A, B)
    unify(C, D)
    unify(B, C)
    unify(D, 1)
    expect(A.deref()).toBe(1)
  })
  it('D = 1, A = B ,B = D', () => {
    const A = createLogicalVar()
    const B = createLogicalVar()
    const C = createLogicalVar()
    const D = createLogicalVar()
    unify(D, 1)
    unify(A, B)
    unify(B, D)
    expect(B.deref()).toBe(1)
    expect(B.bound).toBe(true)
    expect(A.bound).toBe(true)
    expect(A.deref()).toBe(1)
  })
  it('A = B, C = D ,B = C ,', () => {
    const A = createLogicalVar()
    const B = createLogicalVar()
    const C = createLogicalVar()
    const D = createLogicalVar()
    unify(A, B)
    unify(C, D)
    unify(C, B)
    unify(A,1)
    expect(D.deref()).toBe(1)
    expect(B.bound).toBe(true)
    expect(A.bound).toBe(true)
    expect(A.deref()).toBe(1)
  })
  it('{a:{b:A}} = {a:B}', () => {
    const A = createLogicalVar()
    const B = createLogicalVar()

    const flag = unify({ a: { b: A } }, { a: B })
    expect(flag).toBe(true)
    expect(A.bound).toBe(false)
    expect(B.bound).toBe(true)
    expect(B.deref()).toStrictEqual({ b: A })
  })
  it('1 = 2', () => {
    const flag = unify(1, 2)
    expect(flag).toBe(false)
  })
  it('{a:A} = {b:B}', () => {
    const A = createLogicalVar()
    const B = createLogicalVar()
    const flag = unify({ a: A }, { b: B })
    expect(flag).toBe(false)
    expect(A.bound).toBe(false)
    expect(B.bound).toBe(false)
  })
  it('{a:A} = {a:A, b:B}', () => {
    const A = createLogicalVar()
    const B = createLogicalVar()
    expect(unify({ a: A }, { a: A, b: B })).toBe(false)
  })
  it('{a:{b:A}} = {a:{c:B}}', () => {
    const A = createLogicalVar()
    const B = createLogicalVar()
    expect(unify({ a: { b: A } }, { a: { c: B } })).toBe(false)
  })
  it('[A] = []', () => {
    const A = createLogicalVar()
    expect(unify([A], [])).toBe(false)
  })
  it('[A] = []', () => {
    const A = createLogicalVar()
    expect(unify([A], [])).toBe(false)
  })
  it('A ={a:A}', () => {
    const A = createLogicalVar()
    expect(unify(A, { a: A })).toBe(true)
  })
})

describe('unify / failure rollback', () => {
  it('failed unify restores a bound variable', () => {
    const A = createLogicalVar()
    expect(unify({ b: A, a: 1 }, { b: 2, a: 2 })).toBe(false)
    expect(A.bound).toBe(false)
    expect(A.deref()).toBe(undefined)
  })
  it('failed unify restores chained unbound variables', () => {
    const A = createLogicalVar()
    const B = createLogicalVar()
    expect(unify({ p: A, q: B, a: 1 }, { p: B, q: 2, a: 3 })).toBe(false)
    expect(A.bound).toBe(false)
    expect(A.deref()).toBe(undefined)
    expect(B.bound).toBe(false)
    expect(B.deref()).toBe(undefined)
  })
  it('failed unify restores nested bindings', () => {
    const A = createLogicalVar()
    const B = createLogicalVar()
    expect(unify({ x: { y: A, z: B }, w: 1 }, { x: { y: 1, z: 2 }, w: 9 })).toBe(false)
    expect(A.bound).toBe(false)
    expect(B.bound).toBe(false)
  })
  it('successful unify keeps bindings', () => {
    const A = createLogicalVar()
    expect(unify({ b: A, a: 1 }, { b: 2, a: 1 })).toBe(true)
    expect(A.deref()).toBe(2)
  })
  it('caller can undo a successful but unused trial', () => {
    const A = createLogicalVar()
    const trail = createTrail()
    const mark = trail.length
    expect(unify(A, 1, trail)).toBe(true)
    expect(A.deref()).toBe(1)
    undo(trail, mark)
    expect(A.bound).toBe(false)
    expect(A.deref()).toBe(undefined)
  })
})

describe('resolve / remove logical vars from a term', () => {
  it('expands bound vars in nested objects and arrays without mutating the term', () => {
    const A = createLogicalVar()
    unify(A, 1)
    const term = { x: A, ys: [A, 2, { z: A }] }
    expect(resolve(term)).toStrictEqual({ x: 1, ys: [1, 2, { z: 1 }] })
    expect(term.x).toBe(A)
    expect(A.deref()).toBe(1)
  })
  it('follows variable chains', () => {
    const A = createLogicalVar()
    const B = createLogicalVar()
    const C = createLogicalVar()
    unify(A, B)
    unify(B, C)
    unify(C, { v: 3 })
    expect(resolve({ a: A, b: B })).toStrictEqual({ a: { v: 3 }, b: { v: 3 } })
  })
  it('replaces unbound vars with undefined by default, or with a given placeholder', () => {
    const A = createLogicalVar()
    const B = createLogicalVar()
    unify(A, B)
    const term = { a: A, b: [B, 1] }
    expect(resolve(term)).toStrictEqual({ a: undefined, b: [undefined, 1] })
    expect(resolve(term, null)).toStrictEqual({ a: null, b: [null, 1] })
    expect(resolve(A, 'free')).toBe('free')
    expect(isUnboundLogicalVar(A)).toBe(true)
  })
  it('keeps shared references and cycles as a finite graph', () => {
    const A = createLogicalVar()
    unify(A, { self: A })
    const out = resolve<{ self: unknown }>(A)
    expect(out.self).toBe(out)

    const inner = { a: A }
    const shared = resolve<{ p: object; q: object }>({ p: inner, q: inner })
    expect(shared.p).toBe(shared.q)
  })
  it('a snapshot is unaffected by a later undo', () => {
    const A = createLogicalVar()
    const trail = createTrail()
    const mark = trail.length
    unify({ a: A }, { a: 5 }, trail)
    const snapshot = resolve({ a: A })
    undo(trail, mark)
    expect(snapshot).toStrictEqual({ a: 5 })
    expect(A.bound).toBe(false)
  })
})

describe('useTrail / conj & disj', () => {
  it('accepts unify pairs as goals', () => {
    const A = createLogicalVar()
    const B = createLogicalVar()
    const C = createLogicalVar()
    const D = createLogicalVar()
    const ctx = useTrail()
    expect(ctx.conj([A, B], [C, D], [B, C], [D, 1], [2, 2])).toBe(true)
    expect(A.deref()).toBe(1)
  })
  it('still accepts thunk goals', () => {
    const A = createLogicalVar()
    const ctx = useTrail()
    expect(ctx.conj(() => ctx.unify(A, 1), () => ctx.unify(A, 1))).toBe(true)
    expect(A.deref()).toBe(1)
  })
  it('rolls back all bindings when a pair fails', () => {
    const A = createLogicalVar()
    const ctx = useTrail()
    expect(ctx.conj([A, 1], [1, 2])).toBe(false)
    expect(A.bound).toBe(false)
  })
  it('disj tries each branch from a clean state', () => {
    const A = createLogicalVar()
    const ctx = useTrail()
    const branches = ctx.disj([A, 1], [A, 2])
    expect(branches.next().value).toBe(true)
    expect(A.deref()).toBe(1)
    expect(branches.next().value).toBe(true)
    expect(A.deref()).toBe(2)
  })
})

describe('freeze/2', () => {
  it('变量未绑定时挂起，绑定值时唤醒且只执行一次', () => {
    const A = createLogicalVar()
    let seen: unknown = 'not-run'
    let calls = 0
    expect(freeze(A, () => { calls++; seen = A.deref(); return true })).toBe(true)
    expect(seen).toBe('not-run')
    expect(unify(A, 42)).toBe(true)
    expect(seen).toBe(42)
    expect(unify(A, 42)).toBe(true)
    expect(calls).toBe(1)
  })
  it('已绑定变量立即执行目标并返回其结果', () => {
    const A = createLogicalVar()
    unify(A, 1)
    let calls = 0
    expect(freeze(A, () => { calls++; return false })).toBe(false)
    expect(freeze(A, () => { calls++; return true })).toBe(true)
    expect(calls).toBe(2)
  })
  it('A = B 不唤醒，链尾绑定到值时才唤醒', () => {
    const A = createLogicalVar()
    const B = createLogicalVar()
    let calls = 0
    freeze(A, () => { calls++; return true })
    expect(freeze(B, () => { calls++; return true })).toBe(true)
    expect(unify(A, B)).toBe(true)
    expect(calls).toBe(0)
    expect(unify(B, 3)).toBe(true)
    expect(calls).toBe(2)
  })
  it('跨变量链的多个目标按 freeze 调用顺序唤醒', () => {
    const A = createLogicalVar()
    const B = createLogicalVar()
    const order: string[] = []
    freeze(A, () => { order.push('a1'); return true })
    freeze(B, () => { order.push('b1'); return true })
    freeze(A, () => { order.push('a2'); return true })
    expect(unify(A, B)).toBe(true)
    expect(order).toEqual([])
    expect(unify(B, 5)).toBe(true)
    expect(order).toEqual(['a1', 'b1', 'a2'])
  })
  it('目标返回 false 时合一失败，绑定回滚且目标重新挂起', () => {
    const A = createLogicalVar()
    let calls = 0
    freeze(A, () => { calls++; return calls > 1 })
    expect(unify(A, 1)).toBe(false)
    expect(A.bound).toBe(false)
    expect(A.deref()).toBe(undefined)
    expect(unify(A, 2)).toBe(true)
    expect(calls).toBe(2)
    expect(A.deref()).toBe(2)
  })
  it('回溯到 freeze 之后会恢复挂起状态，可在下一个解里再次唤醒', () => {
    const A = createLogicalVar()
    const trail = createTrail()
    let calls = 0
    freeze(A, () => { calls++; return true }, trail)
    const mark = trail.length
    expect(unify(A, 1, trail)).toBe(true)
    expect(calls).toBe(1)
    undo(trail, mark)
    expect(A.bound).toBe(false)
    expect(unify(A, 2, trail)).toBe(true)
    expect(calls).toBe(2)
    expect(A.deref()).toBe(2)
  })
  it('runWithTrail：冻结目标内部的绑定与外层共享同一条 trail', () => {
    const A = createLogicalVar()
    const B = createLogicalVar()
    let calls = 0
    expect(runWithTrail(() => {
      freeze(A, () => { calls++; return unify(B, 7) })
      return unify(A, 1)
    })).toBe(true)
    expect(calls).toBe(1)
    expect(A.deref()).toBe(1)
    expect(B.deref()).toBe(7)
  })
  it('runWithTrail：目标失败时绑定与属性一起回滚', () => {
    const A = createLogicalVar()
    const B = createLogicalVar()
    let calls = 0
    expect(runWithTrail(() => {
      freeze(A, () => { calls++; unify(B, 7); return false })
      return unify(A, 1)
    })).toBe(false)
    expect(calls).toBe(1)
    expect(A.bound).toBe(false)
    expect(B.bound).toBe(false)
    expect(A.attributes.size).toBe(0)
  })
  it('useTrail：conj 里挂起的约束在失败时一并回滚', () => {
    const A = createLogicalVar()
    const ctx = useTrail()
    let calls = 0
    expect(ctx.conj(
      () => { freeze(A, () => { calls++; return false }); return true },
      [A, 1],
    )).toBe(false)
    expect(calls).toBe(1)
    expect(A.bound).toBe(false)
    expect(A.attributes.size).toBe(0)
  })
  it('第一个参数不是逻辑变量时报错', () => {
    expect(() => freeze(1 as never, () => true)).toThrow(TypeError)
  })
})