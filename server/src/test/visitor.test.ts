import { describe, it, expect } from 'vitest'
import { Parser } from '../mercury-parser'
import { Visitor } from '../document-visitor'
import { URI } from 'vscode-uri'

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
    expectLabeled(defs, 'c1', 'c1/0', 'type')
    expectLabeled(defs, 'c2', 'c2/1', 'type')
    assertNoWhereMislabeled(defs)
  })

  it('indexes DU with where attribute block `type T ---> ... where [...].`', async () => {
    const defs = definitionsOf(
      await visitMercury(':- type t_duw ---> c1 ; c2(int) where [ ground(c1) ].'),
    )
    expectLabeled(defs, 't_duw', 't_duw/0', 'type')
    expectLabeled(defs, 'c1', 'c1/0', 'type')
    expectLabeled(defs, 'c2', 'c2/1', 'type')
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
    expectLabeled(defs, 'sc', 'sc/1', 'type')
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
