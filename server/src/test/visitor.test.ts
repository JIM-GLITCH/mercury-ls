import { describe, it, expect, vi } from 'vitest'

// document-manager 运行时依赖 server.ts 的 textDocuments，
// 而 server.ts 顶层 createConnection 需要 LSP 参数，测试环境必须 mock 掉
vi.mock('../server', () => ({
    textDocuments: new Map(),
}))
import { Parser } from '../mercury-parser'
import { Visitor } from '../document-visitor'
import { URI } from 'vscode-uri'
import { sameArity, semanticNameArityOf } from '../utils'
import { termRange } from '../term'
import { findDefTerms, uriTermToLocation } from '../provide-definition'
import { ReferenceProvider } from '../provide-reference'
import { mercuryDocumentFactory, mercuryDocuments } from '../document-manager'

interface DefEntry {
  nameArity: string
  semanticType?: string
}

/** 把一段 interface 区内的声明包进最小可解析的 module 骨架里 */
async function visitMercury(body: string): Promise<Visitor> {
  const src = `:- module test.\n:- interface.\n${body}\n:- end_module test.\n`
  return visitSource(src)
}

async function visitSource(src: string): Promise<Visitor> {
  const doc: any = {
    parseResult: Parser.parse(src),
    uri: URI.parse('file:///test.m'),
    visitResult: undefined,
  }
  const v = new Visitor()
  await v.visit(doc, {
    isCancellationRequested: false,
    onCancellationRequested: () => undefined,
  } as any)
  return v
}

/** 深度收集树中所有 nameArity 匹配的节点 */
function collectTerms(term: any, nameArity: string, acc: any[] = []): any[] {
  if (!term) return acc
  if (term.nameArity === nameArity) acc.push(term)
  for (const a of term.args ?? []) collectTerms(a, nameArity, acc)
  return acc
}

function definitionsOf(v: Visitor): Map<string, DefEntry[]> {
  const m = new Map<string, DefEntry[]>()
  for (const [k, terms] of (v as any).definition.entriesGroupedByKey()) {
    m.set(
      k,
      terms.map((t: any) => ({ nameArity: t.nameArity, semanticType: t.semanticType })),
    )
  }
  return m
}

function declarationsOf(v: Visitor): Map<string, DefEntry[]> {
  const m = new Map<string, DefEntry[]>()
  for (const [k, terms] of (v as any).declaration.entriesGroupedByKey()) {
    m.set(
      k,
      terms.map((t: any) => ({ nameArity: t.nameArity, semanticType: t.semanticType })),
    )
  }
  return m
}

function typeReferencesOf(v: Visitor): Map<string, DefEntry[]> {
  const m = new Map<string, DefEntry[]>()
  for (const [k, terms] of (v as any).typeReference.entriesGroupedByKey()) {
    m.set(
      k,
      terms.map((t: any) => ({ nameArity: t.nameArity, semanticType: t.semanticType })),
    )
  }
  return m
}

function instReferencesOf(v: Visitor): Map<string, DefEntry[]> {
  const m = new Map<string, DefEntry[]>()
  for (const [k, terms] of (v as any).instReference.entriesGroupedByKey()) {
    m.set(
      k,
      terms.map((t: any) => ({ nameArity: t.nameArity, semanticType: t.semanticType })),
    )
  }
  return m
}

function modeReferencesOf(v: Visitor): Map<string, DefEntry[]> {
  const m = new Map<string, DefEntry[]>()
  for (const [k, terms] of (v as any).modeReference.entriesGroupedByKey()) {
    m.set(
      k,
      terms.map((t: any) => ({ nameArity: t.nameArity, semanticType: t.semanticType })),
    )
  }
  return m
}

/** 断言某个名字被标成指定的 semanticType，且 nameArity 精确匹配 */
function expectLabeled(
  defs: Map<string, DefEntry[]>,
  name: string,
  nameArity: string,
  semanticType: string,
) {
  const entries = defs.get(name)
  expect(entries, `expected symbol '${name}' to be indexed as a definition`).toBeTruthy()
  const ok = entries!.some(
    (e) => e.semanticType === semanticType && e.nameArity === nameArity,
  )
  expect(
    ok,
    `expected '${name}' labeled ${semanticType} '${nameArity}', got ${JSON.stringify(entries)}`,
  ).toBe(true)
}

/** 回归保护：where/2 绝不能因为包在外面而被误标成 type */
function assertNoWhereMislabeled(defs: Map<string, DefEntry[]>) {
  for (const [k, entries] of defs) {
    for (const e of entries) {
      expect(
        e.nameArity === 'where/2' && e.semanticType === 'type',
        `symbol '${k}' wrongly labeled type 'where/2'`,
      ).toBe(false)
    }
  }
}

describe('visitor: type declarations', () => {
  it('indexes abstract type `type T.`', async () => {
    const defs = definitionsOf(await visitMercury(':- type t_abstract.'))
    expectLabeled(defs, 't_abstract', 't_abstract/0', 'type')
    assertNoWhereMislabeled(defs)
  })

  it('indexes discriminated union `type T ---> C1 ; C2.`', async () => {
    const defs = definitionsOf(await visitMercury(':- type t_du ---> c1 ; c2(int).'))
    expectLabeled(defs, 't_du', 't_du/0', 'type')
    expectLabeled(defs, 'c1', 'c1/0', 'constructor')
    expectLabeled(defs, 'c2', 'c2/1', 'constructor')
    assertNoWhereMislabeled(defs)
  })

  it('indexes DU with where attribute block `type T ---> ... where [...].`', async () => {
    const defs = definitionsOf(
      await visitMercury(':- type t_duw ---> c1 ; c2(int) where [ ground(c1) ].'),
    )
    expectLabeled(defs, 't_duw', 't_duw/0', 'type')
    expectLabeled(defs, 'c1', 'c1/0', 'constructor')
    expectLabeled(defs, 'c2', 'c2/1', 'constructor')
    assertNoWhereMislabeled(defs)
  })

  it('indexes equivalence type `type T == U.`', async () => {
    const defs = definitionsOf(await visitMercury(':- type t_eq == list(int).'))
    expectLabeled(defs, 't_eq', 't_eq/0', 'type')
    assertNoWhereMislabeled(defs)
  })

  it('indexes bare subtype `type T =< Super.`', async () => {
    const defs = definitionsOf(await visitMercury(':- type t_sub =< some_super.'))
    expectLabeled(defs, 't_sub', 't_sub/0', 'type')
    assertNoWhereMislabeled(defs)
  })

  it('indexes subtype with constructors `type T =< Super ---> ... .`', async () => {
    const defs = definitionsOf(
      await visitMercury(':- type t_sub2 =< some_super ---> sc(int).'),
    )
    expectLabeled(defs, 't_sub2', 't_sub2/0', 'type')
    expectLabeled(defs, 'sc', 'sc/1', 'constructor')
    assertNoWhereMislabeled(defs)
  })

  it('indexes solver type with where `solver type T where ...`', async () => {
    const defs = definitionsOf(
      await visitMercury(
        ':- solver type t_solver where representation = some_rep, ground = ground_rep.',
      ),
    )
    expectLabeled(defs, 't_solver', 't_solver/0', 'type')
    assertNoWhereMislabeled(defs)
  })

  it('indexes type with where attributes `type T where ...`', async () => {
    const defs = definitionsOf(
      await visitMercury(':- type t_where where ground = ground_inst, equality = eq_inst.'),
    )
    expectLabeled(defs, 't_where', 't_where/0', 'type')
    assertNoWhereMislabeled(defs)
  })
})

describe('visitor: typeclass / instance declarations', () => {
  it('indexes typeclass name `typeclass diet_element(T) where ...` as diet_element/1', async () => {
    const v = await visitMercury(
      ':- typeclass diet_element(T) where [ pred foo(T::in) is semidet ].',
    )
    const defs = definitionsOf(v)
    expectLabeled(defs, 'diet_element', 'diet_element/1', 'typeclass')
    assertNoWhereMislabeled(defs)
    // where 块内的方法按 declaration 索引（与模块级 :- pred 一致）
    const decls = declarationsOf(v)
    expectLabeled(decls, 'foo', 'foo/1', 'pred')
  })

  it('indexes instance `inst Name for Type ---> ...` as Name/0, not --->/2', async () => {
    const defs = definitionsOf(
      await visitMercury(
        ':- inst cannot_fail for exception_result/1 ---> succeeded(ground) ; exception(ground).',
      ),
    )
    expectLabeled(defs, 'cannot_fail', 'cannot_fail/0', 'inst')
    expectLabeled(defs, 'succeeded', 'succeeded/1', 'inst')
    expectLabeled(defs, 'exception', 'exception/1', 'inst')
    assertNoWhereMislabeled(defs)
  })
})

describe('visitor: inst declarations', () => {
  it('indexes inst equivalence `inst I == inst_expr.`', async () => {
    const defs = definitionsOf(await visitMercury(':- inst i_eq == ground.'))
    expectLabeled(defs, 'i_eq', 'i_eq/0', 'inst')
    assertNoWhereMislabeled(defs)
  })

  it('indexes inst DU `inst I ---> f ; g.` with constructors', async () => {
    const defs = definitionsOf(await visitMercury(':- inst i_du ---> f ; g.'))
    expectLabeled(defs, 'i_du', 'i_du/0', 'inst')
    expectLabeled(defs, 'f', 'f/0', 'inst')
    expectLabeled(defs, 'g', 'g/0', 'inst')
    assertNoWhereMislabeled(defs)
  })

  it('indexes `inst I for Type/Arity == ... .` (for keyword) as I/0', async () => {
    const defs = definitionsOf(await visitMercury(':- inst i_for for list/1 == ground.'))
    expectLabeled(defs, 'i_for', 'i_for/0', 'inst')
    assertNoWhereMislabeled(defs)
  })
})

describe('visitor: mode declarations', () => {
  it('indexes `mode M == InstA >> InstB.` as M/0', async () => {
    const defs = definitionsOf(await visitMercury(':- mode m_eq == in >> out.'))
    expectLabeled(defs, 'm_eq', 'm_eq/0', 'mode')
  })

  it('indexes `mode M(...) == ... .` (parametrized) as M/n', async () => {
    const defs = definitionsOf(await visitMercury(':- mode m_par(X) == in >> out.'))
    expectLabeled(defs, 'm_par', 'm_par/1', 'mode')
  })
})

/** 回归保护：is/2 是确定性关键字，绝不能被标成 pred/func 进 declaration */
function assertNoIsMislabeled(decls: Map<string, DefEntry[]>) {
  const entries = decls.get('is') ?? []
  expect(
    entries.some((e) => e.semanticType === 'pred' || e.semanticType === 'func'),
    `determinism keyword 'is/2' wrongly labeled: ${JSON.stringify(entries)}`,
  ).toBe(false)
}

describe('visitor: pred / func declarations', () => {
  // 注意：pred/func 索引进 declaration（与 type/inst/typeclass 的 definition 不同）；
  // 返回类型带 :: 注解时必须加括号：(R :: out) is det

  it('indexes `pred P(...) is Detism.` as P/n [pred]', async () => {
    const decls = declarationsOf(await visitMercury(':- pred p1(int, int) is semidet.'))
    expectLabeled(decls, 'p1', 'p1/2', 'pred')
    assertNoIsMislabeled(decls)
  })

  it('indexes `func F(...) = R is Detism.` as F/n [func]', async () => {
    const decls = declarationsOf(await visitMercury(':- func f1(int) = int is det.'))
    expectLabeled(decls, 'f1', 'f1/1', 'func')
    assertNoIsMislabeled(decls)
  })

  it('indexes `pred P(A1 :: in, A2 :: out) is semidet.` (:: inst annotations)', async () => {
    const decls = declarationsOf(await visitMercury(':- pred p2(A1 :: in, A2 :: out) is semidet.'))
    expectLabeled(decls, 'p2', 'p2/2', 'pred')
    assertNoIsMislabeled(decls)
  })

  it('indexes `func F(A1) = (R :: out) is det.` (parenthesized :: return)', async () => {
    const decls = declarationsOf(await visitMercury(':- func f2(A1) = (R :: out) is det.'))
    expectLabeled(decls, 'f2', 'f2/1', 'func')
    assertNoIsMislabeled(decls)
  })

  it('indexes bare `pred P(...).` / `func F(...) = R.` (no is Detism)', async () => {
    const decls = declarationsOf(
      await visitMercury(':- pred p3(int, int).\n:- func f3(int) = int.'),
    )
    expectLabeled(decls, 'p3', 'p3/2', 'pred')
    expectLabeled(decls, 'f3', 'f3/1', 'func')
  })
})

describe('visitor: func definition clauses', () => {
  it('does not label the func body RHS as type (`X ` + "`</>`" + ` Y = X ++ line ++ Y.`)', async () => {
    const src = [
      ':- module test.',
      ':- interface.',
      ':- end_module test.',
      ':- implementation.',
      '',
      'X `</>` Y = X ++ line ++ Y.',
      '',
    ].join('\n')
    const v = await visitSource(src)

    // 函数名正确进 definition
    expectLabeled(definitionsOf(v), '</>', '</>/2', 'func')

    // 函数体 ++/2 不能被标成 type（返回类型只存在于 :- func 声明里）
    const root = Parser.parse(src).value
    const bodyNodes = root.args
      .flatMap((c: any) => collectTerms(c.term, '++/2'))
      .filter((t: any) => t !== undefined)
    expect(bodyNodes.length).toBe(2) // 外层 ++/2 与内层 ++/2
    for (const t of bodyNodes) {
      expect(t.semanticType, `++/2 wrongly labeled '${t.semanticType}'`).not.toBe('type')
    }

    // ++/2 作为引用记录（functor 还是 data constructor 由 linker 阶段区分）
    const refKeys = [...((v as any).reference.entriesGroupedByKey?.() ?? [])].map(([k]: [string]) => k)
    expect(refKeys).toContain('++')
  })
})

describe('visitor: type references (typeReference)', () => {
  it('indexes type refs in type decl bodies (==, =<, DU ctor args)', async () => {
    const v = await visitMercury(
      ':- type t_du ---> c1(int) ; c2(list(string)).\n' +
      ':- type t_eq == list(int).\n' +
      ':- type t_sub =< list(int).',
    )
    const refs = typeReferencesOf(v)
    expectLabeled(refs, 'int', 'int/0', 'type')
    expectLabeled(refs, 'list', 'list/1', 'type')
    expectLabeled(refs, 'string', 'string/0', 'type')
    // 类型名本身是定义，不是引用
    expect(refs.get('t_du')).toBeUndefined()
  })

  it('indexes type refs in pred/func params and returns (incl. :: and >>)', async () => {
    const v = await visitMercury(
      ':- pred p1(int, list(string)) is det.\n' +
      ':- pred p2(list(int) :: in) is semidet.\n' +
      ':- pred p3(list(int) >> in) is det.\n' +
      ':- func f1(int) = list(int) is det.',
    )
    const refs = typeReferencesOf(v)
    expectLabeled(refs, 'int', 'int/0', 'type')
    expectLabeled(refs, 'list', 'list/1', 'type')
    expectLabeled(refs, 'string', 'string/0', 'type')
  })

  it('indexes typeclass method signature type refs but skips type variables', async () => {
    const v = await visitMercury(':- typeclass tc(T) where [ pred m1(int, T) is det ].')
    const refs = typeReferencesOf(v)
    expectLabeled(refs, 'int', 'int/0', 'type')
    // 类型变量 T 不是类型引用
    expect(refs.get('T')).toBeUndefined()
  })

  it('indexes type refs in instance heads and `inst I for Type/Arity`', async () => {
    const v = await visitMercury(
      ':- typeclass tc(T) where [].\n' +
      ':- instance tc(int) where [].\n' +
      ':- inst i_for for list/1 == ground.',
    )
    const refs = typeReferencesOf(v)
    expectLabeled(refs, 'int', 'int/0', 'type')
    // `for list/1` 的 Type 位置解析为裸名 list/0
    expectLabeled(refs, 'list', 'list/0', 'type')
  })

  it('indexes type refs in mutable decls and term-level `::` / `:` qualifications', async () => {
    const src = [
      ':- module test.',
      ':- interface.',
      ':- mutable(mut_var, list(int), ground, [], []).',
      ':- end_module test.',
      ':- implementation.',
      'r1(X, Y) :- Y = (X :: list(int)).',
      'r2(X, Y) :- Y = (X : list(int)).',
      '',
    ].join('\n')
    const v = await visitSource(src)
    const refs = typeReferencesOf(v)
    expectLabeled(refs, 'list', 'list/1', 'type')
    expectLabeled(refs, 'int', 'int/0', 'type')
  })

  it('sets semanticArity for `inst I for Type/Arity` type refs', async () => {
    const v = await visitMercury(
      ':- inst node for diet/1 ---> node(ground, ground, ground, ground).',
    )
    const dietTerms = (v as any).typeReference.get('diet') ?? []
    expect(dietTerms.length).toBe(1)
    // 语法 arity 是 0（裸原子），语义元数是 Type/Arity 里的 1
    expect(dietTerms[0].arity).toBe(0)
    expect(dietTerms[0].semanticArity).toBe(1)
    // hover 显示 diet/1（而非 diet/0）
    expect(semanticNameArityOf(dietTerms[0])).toBe('diet/1')
    // 定义查找：与真实的 diet/1 定义匹配，与 diet/0 定义不匹配
    expect(sameArity({ arity: 1 } as any, dietTerms[0])).toBe(true)
    expect(sameArity({ arity: 0 } as any, dietTerms[0])).toBe(false)
  })

  it('sets semanticArity (+2) for DCG heads and DCG body calls', async () => {
    const v = await visitSource(
      ':- module test.\n:- interface.\n:- end_module test.\n' +
      ':- implementation.\ns --> [a].\nt --> s.\n',
    )
    // DCG 头 s/0：语法 arity 0，语义元数 2（隐式输入/输出列表）
    const defTerms = (v as any).definition.get('s') ?? []
    expect(defTerms.length).toBe(1)
    expect(defTerms[0].arity).toBe(0)
    expect(defTerms[0].semanticArity).toBe(2)
    expect(semanticNameArityOf(defTerms[0])).toBe('s/2')
    // DCG 体里的调用 s/0（语义元数 2）与定义匹配
    const refTerms = (v as any).reference.get('s') ?? []
    expect(refTerms.length).toBe(1)
    expect(refTerms[0].arity).toBe(0)
    expect(refTerms[0].semanticArity).toBe(2)
    expect(sameArity(defTerms[0], refTerms[0])).toBe(true)
  })
})

describe('visitor: inst references (instReference)', () => {
  it('indexes inst refs in parametrized modes `Type :: in(Inst)`', async () => {
    const v = await visitMercury(
      ':- pred take_min(diet(T)::in(node), interval(T)::out, diet(T)::out) is det\n' +
      '    <= diet_element(T).',
    )
    // `in(node)` 的 node 是 inst 引用；`in` 是内置 mode，标 mode 但不进 modeReference
    const refs = instReferencesOf(v)
    expectLabeled(refs, 'node', 'node/0', 'inst')
    expect(modeReferencesOf(v).get('in')).toBeUndefined()
    // 类型位置照常进 typeReference
    const typeRefs = typeReferencesOf(v)
    expectLabeled(typeRefs, 'diet', 'diet/1', 'type')
    expectLabeled(typeRefs, 'interval', 'interval/1', 'type')
    // 带约束的声明（is det <= Constraint）整体也能被索引
    const decls = declarationsOf(v)
    expectLabeled(decls, 'take_min', 'take_min/3', 'pred')
  })

  it('indexes `Type :: Mode` position as a mode ref (modeReference)', async () => {
    const v = await visitMercury(':- pred p(T :: node) is det.')
    // `::` 右侧是 mode 位置：标 mode、进 modeReference，不再进 instReference
    const modeRefs = modeReferencesOf(v)
    expectLabeled(modeRefs, 'node', 'node/0', 'mode')
    expect(instReferencesOf(v).get('node')).toBeUndefined()
    // 声明本身照常索引
    expect(declarationsOf(v).get('p')?.length).toBe(1)
  })

  it('indexes higher-order func types and modes without keyword noise', async () => {
    const v = await visitMercury(
      ':- pred map_keys_func_2(func(V, K) = L::in(func(in, in) = out is det),\n' +
      '    assoc_list(K, V)::in, assoc_list(L, V)::in, assoc_list(L, V)::out) is det.\n' +
      ':- pred q(func(int) = int).\n' +
      ':- pred r(pred(T)::in(pred(in) is semidet)).',
    )
    // 类型位置：assoc_list ×3、高阶 func 的参数与返回 int ×2
    const typeRefs = typeReferencesOf(v)
    expectLabeled(typeRefs, 'assoc_list', 'assoc_list/2', 'type')
    expectLabeled(typeRefs, 'int', 'int/0', 'type')
    // `=`/`func`/`pred` 是关键字，不进任何引用索引
    expect(typeRefs.get('=')).toBeUndefined()
    expect(typeRefs.get('func')).toBeUndefined()
    expect(typeRefs.get('pred')).toBeUndefined()
    // mode 位置：参数模式与高阶模式参数都标 mode；内置 in/out 不进 modeReference
    const modeRefs = modeReferencesOf(v)
    expect(modeRefs.get('in')).toBeUndefined()
    expect(modeRefs.get('out')).toBeUndefined()
    // 自定义 mode 名仍进 modeReference（见 mode-refs.m provider 测试）
    // `is`/`func` 不进 instReference
    expect(instReferencesOf(v).get('is')).toBeUndefined()
    expect(instReferencesOf(v).get('func')).toBeUndefined()
    // 声明照常索引
    const decls = declarationsOf(v)
    expectLabeled(decls, 'map_keys_func_2', 'map_keys_func_2/4', 'pred')
    expectLabeled(decls, 'q', 'q/1', 'pred')
    expectLabeled(decls, 'r', 'r/1', 'pred')
  })

  it('does not record `::` as a type ref for `(R :: out) is det` func returns', async () => {
    const v = await visitMercury(':- func f2(A1) = (R :: out) is det.')
    const typeRefs = typeReferencesOf(v)
    expect(typeRefs.get('::')).toBeUndefined()
    const decls = declarationsOf(v)
    expectLabeled(decls, 'f2', 'f2/1', 'func')
  })

  it('indexes inst refs in `mode M == InstA >> InstB`', async () => {
    const v = await visitMercury(':- mode m1 == node >> ground.')
    const refs = instReferencesOf(v)
    expectLabeled(refs, 'node', 'node/0', 'inst')
    // 内置 inst ground 不进 instReference
    expect(refs.get('ground')).toBeUndefined()
    // mode 名本身仍是定义
    expectLabeled(definitionsOf(v), 'm1', 'm1/0', 'mode')
  })

  it('does not index builtin insts (ground/any/free)', async () => {
    const v = await visitMercury(
      ':- pred p(T :: in(ground), T2 :: in(any), T3 :: in(free)) is det.',
    )
    const refs = instReferencesOf(v)
    expect(refs.get('ground')).toBeUndefined()
    expect(refs.get('any')).toBeUndefined()
    expect(refs.get('free')).toBeUndefined()
    // 声明照常索引
    expectLabeled(declarationsOf(v), 'p', 'p/3', 'pred')
  })
})

describe('visitor: pred/func reference positions (reference)', () => {
  it('indexes `Name/Arity` closure refs in clause bodies as pred refs', async () => {
    const v = await visitSource(
      ':- pred p(int, int).\n' +
      'p(A, B) :- q(A), R = p/2.\n' +
      ':- pred q(int).\n',
    )
    const refs = (v as any).reference
    const pRefs = refs.get('p') ?? []
    expect(pRefs.length).toBe(1)
    expect(pRefs[0].semanticArity).toBe(2)
    expect(pRefs[0].semanticType).toBe('pred')
    // `/` 本体不进 reference
    expect(refs.get('/')?.length ?? 0).toBe(0)
  })

  it('indexes initialise / finalise PredName as pred refs', async () => {
    const v = await visitSource(':- pred p(int, int).\n:- initialise p/2.\n:- finalise p/2.\n')
    const refs = (v as any).reference
    const pRefs = refs.get('p') ?? []
    expect(pRefs.length).toBe(2)
    for (const r of pRefs) {
      expect(r.semanticArity).toBe(2)
      expect(r.semanticType).toBe('pred')
    }
    expect(refs.get('/')?.length ?? 0).toBe(0)
  })

  it('indexes pred/func refs inside pragmas', async () => {
    const v = await visitSource(
      [
        ':- pred p(int, int).',
        ':- pred o(int).',
        ':- pragma inline(p/2).',
        ':- pragma no_inline(p/2).',
        ':- pragma promise_pure(p/2).',
        ':- pragma obsolete(o/1).',
        ':- pragma obsolete_proc(o/1, "msg").',
        ':- pragma foreign_export("C", p/2, "c_p").',
        ':- pragma foreign_proc("C", p(X::in, Y::out), [will_not_call_mercury], "Y = X;").',
      ].join('\n'),
    )
    const refs = (v as any).reference
    // p/2 ×4（inline/no_inline/promise_pure/foreign_export）+ foreign_proc 头
    const pRefs = refs.get('p') ?? []
    expect(pRefs.length).toBe(5)
    const arity2 = pRefs.filter((r: any) => (r.semanticArity ?? r.arity) === 2)
    expect(arity2.length).toBe(5)
    expect(refs.get('/')?.length ?? 0).toBe(0)
    // o/1（obsolete / obsolete_proc）
    const oRefs = refs.get('o') ?? []
    expect(oRefs.length).toBe(2)
    expect(oRefs[0].semanticArity).toBe(1)
    expect(refs.get('"C"')?.length ?? 0).toBe(0)
    expect(refs.get('"msg"')?.length ?? 0).toBe(0)
  })

  it('indexes foreign_export_enum ctor refs without pred label', async () => {
    const v = await visitSource(
      ':- pragma foreign_export_enum("C", color/0, prefix("col_")).',
    )
    const refs = (v as any).reference
    const colorRefs = refs.get('color') ?? []
    expect(colorRefs.length).toBe(1)
    expect(colorRefs[0].semanticArity).toBe(0)
    expect(colorRefs[0].semanticType).toBeUndefined()
    expect(refs.get('/')?.length ?? 0).toBe(0)
  })

  it('skips goal-level purity prefixes (impure/semipure/pure) and indexes the goal', async () => {
    const v = await visitSource(
      ':- pred garbage_collect(!IO).\n' +
      'garbage_collect(!IO) :-\n' +
      '    impure garbage_collect.\n',
    )
    const refs = (v as any).reference
    // impure 是关键字不进 reference；目标本体 garbage_collect 正常索引
    const gcRefs = refs.get('garbage_collect') ?? []
    expect(gcRefs.length).toBe(1)
    expect(gcRefs[0].semanticType).toBe('pred')
    expect(refs.get('impure')?.length ?? 0).toBe(0)
  })

  it('treats predicate()/function() higher-order types like pred()/func()', async () => {
    const v = await visitSource(
      ':- pred h(predicate(int), function(int) = int).\n',
    )
    const typeRefs = typeReferencesOf(v)
    expectLabeled(typeRefs, 'int', 'int/0', 'type')
    expect(typeRefs.get('predicate')).toBeUndefined()
    expect(typeRefs.get('function')).toBeUndefined()
  })
})

describe('goto definition / find references for insts (providers)', () => {
  const visitDoc = async (src: string, uri: URI) => {
    const doc = mercuryDocumentFactory.fromString(src, uri)
    mercuryDocuments.addDocument(doc)
    await new Visitor().visit(doc, {
      isCancellationRequested: false,
      onCancellationRequested: () => undefined,
    } as any)
    return doc
  }

  it('goto def of inst ref resolves to the inst definition, not the same-name type', async () => {
    const src = [
      ':- module test.',
      ':- interface.',
      ':- type i_node.',                        // 同名同元数的 type 定义
      ':- inst i_node ---> n.',                 // inst 定义
      ':- pred q(int :: in(i_node)) is det.',   // inst 引用位置
      ':- end_module test.',
      '',
    ].join('\n')
    const uri = URI.parse('file:///inst-goto-def.m')
    const doc = await visitDoc(src, uri)

    const refTerm = doc.visitResult!.instReference.get('i_node')[0]
    const locs = (await findDefTerms({ uri, term: refTerm } as any))
      .map(uriTermToLocation)
      .toArray()
    expect(locs.length).toBe(1)
    // 命中的应是 inst 定义（第 4 行，0 基 3），而不是同名的 type 定义
    expect(locs[0].range.start.line).toBe(3)
  })

  it('find references from the inst definition locates inst refs only', async () => {
    const src = [
      ':- module test2.',
      ':- interface.',
      ':- inst j_node ---> n.',
      ':- pred r(int :: in(j_node)) is det.',
      ':- end_module test2.',
      '',
    ].join('\n')
    const uri = URI.parse('file:///inst-find-refs.m')
    const doc = await visitDoc(src, uri)

    const defTerm = doc.visitResult!.definition.get('j_node')[0]
    const refs = await ReferenceProvider({
      textDocument: { uri: uri.toString() },
      position: termRange(defTerm).start,
    } as any)
    expect(refs.length).toBe(1)
    // 引用在 r 声明的 in(j_node) 里（第 4 行，0 基 3）
    expect(refs[0].range.start.line).toBe(3)
  })

  it('goto def / find refs work for mode refs', async () => {
    const src = [
      ':- module test3.',
      ':- interface.',
      ':- mode my_mode == ground >> ground.',
      ':- pred s(int :: my_mode) is det.',
      ':- end_module test3.',
      '',
    ].join('\n')
    const uri = URI.parse('file:///mode-refs.m')
    const doc = await visitDoc(src, uri)

    // goto def：mode 引用 → mode 定义（第 3 行，0 基 2）
    const refTerm = doc.visitResult!.modeReference.get('my_mode')[0]
    expect(refTerm.semanticType).toBe('mode')
    const locs = (await findDefTerms({ uri, term: refTerm } as any))
      .map(uriTermToLocation)
      .toArray()
    expect(locs.length).toBe(1)
    expect(locs[0].range.start.line).toBe(2)

    // find refs：mode 定义 → mode 引用（第 4 行，0 基 3）
    const defTerm = doc.visitResult!.definition.get('my_mode')[0]
    const refs = await ReferenceProvider({
      textDocument: { uri: uri.toString() },
      position: termRange(defTerm).start,
    } as any)
    expect(refs.length).toBe(1)
    expect(refs[0].range.start.line).toBe(3)
  })
})
