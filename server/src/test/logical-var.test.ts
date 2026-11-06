import { describe, expect, it } from 'vitest'
import { createLogicalVar, createTrail, isUnboundLogicalVar, resolve, undo, unify } from '../logical-var'


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