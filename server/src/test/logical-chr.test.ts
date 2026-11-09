import { describe, expect, it } from 'vitest'
import { CHR_Rule, createCHR, type Rule } from '../logical-chr'
import { createLogicVar, resolve, unify } from '../logical-var'

type Stored = { id: number; term: unknown }

const sortedStore = (chr: { store: readonly Stored[] }): Stored[] =>
  resolve<Stored[]>(chr.store).slice().sort((a, b) => a.id - b.id)

const headsOf = (r: Rule): { a: unknown }[] =>
  (r as unknown as { heads: { a: unknown }[] }).heads

describe('CHR_Rule / ω_r', () => {
  it('simplification：每次 Activate 都把约束替换成 body', () => {
    const chr = createCHR<number>([
      CHR_Rule([[1], '<=>', [2]])
    ])
    chr.add(1)
    chr.add(1)
    expect(resolve(chr.store)).toEqual([
      { id: 1, term: 2 },
      { id: 3, term: 2 },
    ])
  })

  it('值相同的两个 head 合并，值不同的留在 S', () => {
    const A = createLogicVar()
    const C = createLogicVar()
    const chr = createCHR([
      CHR_Rule([[{ a: A }, { a: A }], '<=>', [{ a: A }]])
    ])
    chr.add({ a: C })
    chr.add({ a: 1 })
    chr.add({ a: 2 })
    chr.add({ a: 2 })
    expect(sortedStore(chr)).toEqual([
      { id: 2, term: { a: 1 } },
      { id: 5, term: { a: 2 } },
    ])
  })

  it('DSL 里的 LogicVar 只是占位符：每次应用 fresh rename', () => {
    const A = createLogicVar()
    const rule = CHR_Rule([[{ a: A }, { a: A }], '<=>', [{ a: A }]])
    const first = headsOf(rule())
    const second = headsOf(rule())
    expect(first[0].a).not.toBe(A)
    expect(first[0].a).toBe(first[1].a)
    expect(second[0].a).not.toBe(first[0].a)
    expect(second[0].a).toBe(second[1].a)
  })

  it('head 匹配是对称 unify：store 侧的变量同样被合一', () => {
    const P = createLogicVar()
    const A = createLogicVar()
    const B = createLogicVar()
    const chr = createCHR([
      CHR_Rule([[{ a: P }, { a: P }], '<=>', [{ a: P }]])
    ])
    chr.add({ a: A })
    chr.add({ a: B })
    unify(A, 7)
    expect(resolve({ a: A, b: B })).toEqual({ a: 7, b: 7 })
    expect(chr.store.length).toBe(1)
  })

  it('guard 失败时未采用的候选合一被逐层回滚', () => {
    const P = createLogicVar()
    const A = createLogicVar()
    const B = createLogicVar()
    const chr = createCHR([
      CHR_Rule([[{ a: P }, { a: P }], '<=>', () => false, '|', [{ a: P }]])
    ])
    chr.add({ a: A })
    chr.add({ a: B })
    unify(A, 7)
    expect(resolve({ p: A, q: B }, 'FREE')).toEqual({ p: 7, q: 'FREE' })
    expect(chr.store.length).toBe(2)
  })
})

describe('CHR Reactivate', () => {
  const guardedRule = () => CHR_Rule(() => {
    const A = createLogicVar<number>()
    return [[{ a: A }], '==>', () => A.deref() === 7, '|', [{ hit: A }]] as const
  })

  it('外部 unify 绑定变量后，S 里的约束重新 active 并触发规则', () => {
    const X = createLogicVar()
    const chr = createCHR([guardedRule()])

    chr.add({ a: X })
    expect(sortedStore(chr)).toEqual([{ id: 0, term: { a: undefined } }])

    expect(unify(X, 7)).toBe(true)
    expect(sortedStore(chr)).toEqual([
      { id: 0, term: { a: 7 } },
      { id: 1, term: { hit: 7 } },
    ])
  })

  it('变量链合并本身不唤醒，链尾绑定到值才 Reactivate', () => {
    const X = createLogicVar()
    const Y = createLogicVar()
    const chr = createCHR([guardedRule()])

    chr.add({ a: X })
    chr.add({ a: Y })
    expect(unify(X, Y)).toBe(true)
    expect(chr.store.length).toBe(2)

    expect(unify(Y, 7)).toBe(true)
    const hits = chr.store.filter(c => 'hit' in (c.term as object))
    expect(hits.length).toBe(2)
  })

  it('绑定到不满足 guard 的值不会留下错误的规则结果', () => {
    const X = createLogicVar()
    const chr = createCHR([guardedRule()])

    chr.add({ a: X })
    expect(unify(X, 8)).toBe(true)
    expect(sortedStore(chr)).toEqual([{ id: 0, term: { a: 8 } }])
  })
})

describe('CHR_Rule 工厂写法（无 env）', () => {
  const factoryRule = () => CHR_Rule(() => {
    const A = createLogicVar<number>()
    return [[{ a: A }], '==>', () => A.deref() === 7, '|', [{ hit: A }]] as const
  })

  it('每次应用重新调用工厂，得到 fresh 变量', () => {
    const r = factoryRule()
    const first = headsOf(r())
    const second = headsOf(r())
    expect(first[0].a).not.toBe(second[0].a)
  })

  it('guard 直接读闭包变量，body 展开成值', () => {
    const chr = createCHR([factoryRule()])
    chr.add({ a: 7 })
    expect(sortedStore(chr)).toEqual([
      { id: 0, term: { a: 7 } },
      { id: 1, term: { hit: 7 } },
    ])
  })

  it('guard 不满足时不产生 body', () => {
    const chr = createCHR([factoryRule()])
    chr.add({ a: 8 })
    expect(sortedStore(chr)).toEqual([{ id: 0, term: { a: 8 } }])
  })

  it('body 里的自由变量保持为变量对象，不被展开成 undefined', () => {
    const chr = createCHR([CHR_Rule(() => {
      const A = createLogicVar()
      return [[{ a: A }], '==>', [{ hit: A }]] as const
    })])
    chr.add({ a: createLogicVar() })
    const hit = chr.store.find(c => 'hit' in (c.term as object))
    expect(resolve((hit!.term as { hit: unknown }).hit, 'FREE')).toBe('FREE')
  })
})
