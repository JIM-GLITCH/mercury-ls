import { describe, it, expect } from 'vitest'

import { Parser } from '../mercury-parser'
import { Visitor } from '../document-visitor'
import { URI } from 'vscode-uri'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { sameArity, semanticNameArityOf } from '../utils'
import { termRange } from '../term'
import { findDefTerms, TypeDefinitionProvider, uriTermToLocation } from '../provide-definition'
import { ReferenceProvider } from '../provide-reference'
import { linker } from '../document-linker'
import { exportManager, moduleManager } from '../document-moduleManager'
import { mercuryDocumentFactory, mercuryDocuments } from '../document-manager'
import { orderByImports, scanHeader } from '../document-order'
import { HoverProvider } from '../provide-hover'
import { merTypeToString } from '../document-type'
import { modeRefToInsts } from '../document-mode'
import { semanticTokensForDocument } from '../provide-semantic-tokens'

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

// 跑 visitor + linker，返回带 linkResult 的文档（端到端消歧验证用）
async function linkSource(src: string): Promise<any> {
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
  await linker.link(doc, {
    isCancellationRequested: false,
    onCancellationRequested: () => undefined,
  } as any)
  return doc
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

it('produces semantic tokens for definition names', async () => {
  const src = `
:- module test.
:- interface.
:- pred foo(int::in, int::out).
:- end_module test.
`
  const doc: any = {
    parseResult: Parser.parse(src),
    uri: URI.parse('file:///test.m'),
    textDocument: TextDocument.create('file:///test.m', 'mercury', 0, src),
    visitResult: undefined,
  }
  const v = new Visitor()
  await v.visit(doc, {
    isCancellationRequested: false,
    onCancellationRequested: () => undefined,
  } as any)

  const tokens = semanticTokensForDocument(doc)
  expect(tokens.data.length).toBeGreaterThan(0)
})

it('does not remap control keywords to semantic tokens', async () => {
  const src = `
:- module test.
:- interface.

foo(X) :-
    ( if X = 1 then X = 2 else X = 3 ).

:- implementation.

foo(_) :- true.
:- end_module test.
`
  const doc: any = {
    parseResult: Parser.parse(src),
    uri: URI.parse('file:///test.m'),
    textDocument: TextDocument.create('file:///test.m', 'mercury', 0, src),
    visitResult: undefined,
  }
  const v = new Visitor()
  await v.visit(doc, {
    isCancellationRequested: false,
    onCancellationRequested: () => undefined,
  } as any)

  const tokens = semanticTokensForDocument(doc)
  const data = tokens.data
  expect(data.length).toBeGreaterThan(0)
  expect(data.some((value, idx) => idx % 5 === 3 && value === 16)).toBe(false)
})

it('does not highlight the first variable of an infix expression as the operator function', async () => {
  const src = `
:- module test.
:- interface.

foo(Acc0, X, Y) :-
    Acc1 = Acc0 + (to_int(Y) - to_int(X)) + 1.

:- end_module test.
`
  const doc: any = {
    parseResult: Parser.parse(src),
    uri: URI.parse('file:///test.m'),
    textDocument: TextDocument.create('file:///test.m', 'mercury', 0, src),
    visitResult: undefined,
  }
  const v = new Visitor()
  await v.visit(doc, {
    isCancellationRequested: false,
    onCancellationRequested: () => undefined,
  } as any)

  const tokens = semanticTokensForDocument(doc)
  const tokenPairs = [] as Array<[number, number, number, number]>
  for (let i = 0; i + 4 < tokens.data.length; i += 5) {
    tokenPairs.push([tokens.data[i], tokens.data[i + 1], tokens.data[i + 2], tokens.data[i + 3]])
  }

  const colorsAcc0 = tokenPairs.filter(([deltaLine, deltaStart, length, tokenType]) =>
    deltaLine === 3 && deltaStart === 4 && length >= 5 && tokenType === 12,
  )
  expect(colorsAcc0).toHaveLength(0)
})

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

describe('visitor: qualified declaration names', () => {
  it('keeps qualified predicate declarations as pred symbols, not type refs', async () => {
    const v = await visitMercury([
      ':- pred bag.least_upper_bound_small_loop(map(T, int)::in, map(T, int)::in, map(T, int)::out) is det.',
    ].join('\n'))
    const decls = declarationsOf(v)
    expectLabeled(decls, 'least_upper_bound_small_loop', 'least_upper_bound_small_loop/3', 'pred')
    expect(decls.get('bag')?.some((e: any) => e.semanticType === 'type')).toBeFalsy()
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

  it('skips declaration-level purity prefixes (impure/semipure/pure)', async () => {
    const v = await visitSource(
      ':- impure pred imp is det.\n' +
      ':- semipure pred semip is det.\n',
    )
    const decls = declarationsOf(v)
    expectLabeled(decls, 'imp', 'imp/0', 'pred')
    expectLabeled(decls, 'semip', 'semip/0', 'pred')
    // purity 前缀词头不进任何索引
    expect((v as any).reference.get('impure')?.length ?? 0).toBe(0)
    expect((v as any).reference.get('semipure')?.length ?? 0).toBe(0)
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

  it('visits implementation-defined ($name) terms without throwing', async () => {
    const v = await visitSource(
      ':- pred q(int).\n' +
      'q(A) :- w($foo, A).\n' +
      ':- pred w(int, int).\n',
    )
    const refs = (v as any).reference
    // visit 不再抛 "Method not implemented."；$name 项标注但不进 reference
    expect(refs.get('$foo')?.length ?? 0).toBe(0)
    expect(refs.get('w')?.length).toBe(1)
  })

  it('indexes functor args (nested calls/constructors/closures) as references', async () => {
    const v = await visitSource(
      ':- pred q(int, int).\n' +
      'q(A, B) :- wrap(pair(A, B), uva.init(A)), map(p/2, Xs).\n' +
      ':- pred wrap(int, int).\n' +
      ':- pred p(int, int).\n',
    )
    const refs = (v as any).reference
    // 参数位置的嵌套 functor 也进 reference（此前只有顶层 wrap/map）
    expect(refs.get('wrap')?.length).toBe(1)
    expect(refs.get('pair')?.length).toBe(1)
    expect(refs.get('init')?.length).toBe(1)
    expect((refs.get('init')[0] as any).qualified?.name).toBe('uva')
    // 参数位置的闭包 p/2（Name/Arity）记语义元数
    expect(refs.get('p')?.length).toBe(1)
    expect((refs.get('p')[0] as any).semanticArity).toBe(2)
  })

  it('does not index keyword functors reached through argument/lambda positions', async () => {
    const v = await visitSource(
      ':- pred map(int, int).\n' +
      'm(Xs) :- map(pred(X) is det :- X = 1, Xs).\n',
    )
    const refs = (v as any).reference
    // 子句本身被解析并索引
    expect(refs.get('map')?.length).toBe(1)
    // lambda 头 `pred(X) is det` 与体内 `X = 1` 的关键字不进 reference
    expect(refs.get('is')?.length ?? 0).toBe(0)
    expect(refs.get('=')?.length ?? 0).toBe(0)
    expect(refs.get('pred')?.length ?? 0).toBe(0)
  })

  it('resolves foreign_proc function head init/2 to its def', async () => {
    const src = [
      ':- module t.',
      ':- interface.',
      ':- type va ---> empty.',
      ':- func init(int, int) = va.',
      ':- end_module t.',
      ':- implementation.',
      'init(N, X) = empty.',
      ':- pragma foreign_proc("C#",',
      '    init(N::in, X::in) = (VA::out),',
      '    [will_not_call_mercury, promise_pure, thread_safe],',
      '    "VA = new version_array.ML_sva(version_array.ML_uva.init(N, X));").',
    ].join('\n')
    const uri = URI.parse('file:///foreign-proc-func.m')
    const doc = await visitDoc(src, uri)

    // foreign_proc 函数形式的头标 func（解包 =/2），而不是把 = 记成引用
    const refTerm = doc.visitResult!.reference.get('init')
      .find((t: any) => t.semanticType === 'func')
    expect(refTerm).toBeTruthy()
    expect((refTerm as any).semanticArity ?? (refTerm as any).arity).toBe(2)
    const locs = (await findDefTerms({ uri, term: refTerm } as any))
      .map(uriTermToLocation)
      .toArray()
    expect(locs.length).toBe(1)
  })

  it('labels unlabeled expression functors via linker resolution (func vs constructor)', async () => {
    const src = [
      ':- module t.',
      ':- interface.',
      ':- type va ---> empty ; cell(int, va).',
      ':- func init(int, int) = va.',
      ':- end_module t.',
      ':- implementation.',
      'init(N, X) = empty.',
      'f(N, X) = VA :-',
      '    VA0 = init(N, X),',
      '    VA = VA0,',
      '    VA1 = cell(1, VA0).',
    ].join('\n')
    const uri = URI.parse('file:///linker-label.m')
    const doc = await visitDoc(src, uri)
    await linker.link(doc, {
      isCancellationRequested: false,
      onCancellationRequested: () => undefined,
    } as any)

    // init(N, X) 按定义消解为 func；cell(1, VA0) 是构造子，不被误标 func
    const initRef = doc.visitResult!.reference.get('init')[0]
    expect(initRef.semanticType).toBe('func')
    const cellRef = doc.visitResult!.reference.get('cell')[0]
    expect(cellRef.semanticType).toBe('constructor')
  })

  it('keeps overloaded functors unlabeled when func and constructor candidates coexist', async () => {
    const mk = async (src: string, name: string) => {
      const uri = URI.parse(`file:///${name}.m`)
      const doc = mercuryDocumentFactory.fromString(src, uri)
      mercuryDocuments.addDocument(doc)
      await new Visitor().visit(doc, {
        isCancellationRequested: false,
        onCancellationRequested: () => undefined,
      } as any)
      const mod = doc.visitResult!.module
      if (mod) moduleManager.set(mod, doc)
      exportManager.set(doc)
      return doc
    }
    // mint 导出 `-/2` 函数（减法）；mpair 导出 `-/2` 构造子（pair 的 K - V）
    await mk(':- module mint.\n:- interface.\n:- func int - int = int.\n:- end_module mint.\n', 'mint-mod')
    await mk(':- module mpair.\n:- interface.\n:- type pair(K, V) ---> K - V.\n:- end_module mpair.\n', 'mpair-mod')
    const docM = await mk(
      ':- module m.\n:- interface.\n:- end_module m.\n:- implementation.\nf(K, V) = P :- P = K - V.\n',
      'm-ovl',
    )
    await linker.link(docM, {
      isCancellationRequested: false,
      onCancellationRequested: () => undefined,
    } as any)
    // `-` 同时是 func 与构造子候选，类别不唯一 → 不标注（goto def 走不限类别匹配）
    const ref = docM.visitResult!.reference.get('-')[0]
    expect(ref.semanticType).toBeUndefined()
  })

  it('disambiguates imported type constructor via cross-module inference (pair -/2)', async () => {
    const mk = async (src: string, name: string) => {
      const uri = URI.parse(`file:///${name}.m`)
      const doc = mercuryDocumentFactory.fromString(src, uri)
      mercuryDocuments.addDocument(doc)
      await new Visitor().visit(doc, {
        isCancellationRequested: false,
        onCancellationRequested: () => undefined,
      } as any)
      const mod = doc.visitResult!.module
      if (mod) moduleManager.set(mod, doc)
      exportManager.set(doc)
      return doc
    }
    // mpair 导出类型 pair(K, V) ---> K - V（构造子 `-`/2 在另一模块）
    await mk(':- module mpair.\n:- interface.\n:- type pair(K, V) ---> K - V.\n:- end_module mpair.\n', 'mpair-x')
    // muser 导入 mpair，子句里 `!:List = [1 - 2 | !.List]`，!List 类型经头签名推为 list(pair(int,int))
    const docM = await mk(
      ':- module muser.\n' +
      ':- interface.\n' +
      ':- import_module mpair.\n' +
      ':- pred p(list(pair(int, int))::out) is det.\n' +
      ':- end_module muser.\n' +
      ':- implementation.\n' +
      'p(!List) :- !:List = [1 - 2 | !.List].\n',
      'muser-x',
    )
    await linker.link(docM, {
      isCancellationRequested: false,
      onCancellationRequested: () => undefined,
    } as any)
    // `1 - 2` 出现在 list(pair(int,int)) 元素位置，pair 类型来自导入模块 → 精确标构造子
    const mins = collectTerms(docM.parseResult.value, '-/2')
    expect(mins.length).toBeGreaterThan(0)
    for (const t of mins) expect(t.semanticType).toBe('constructor')
  })

  it('resolves direct imported pair constructor use without expected list context', async () => {
    const mk = async (src: string, name: string) => {
      const uri = URI.parse(`file:///${name}.m`)
      const doc = mercuryDocumentFactory.fromString(src, uri)
      mercuryDocuments.addDocument(doc)
      await new Visitor().visit(doc, {
        isCancellationRequested: false,
        onCancellationRequested: () => undefined,
      } as any)
      const mod = doc.visitResult!.module
      if (mod) moduleManager.set(mod, doc)
      exportManager.set(doc)
      return doc
    }
    await mk(':- module mpair.\n:- interface.\n:- type pair(K, V) ---> K - V.\n:- end_module mpair.\n', 'mpair-direct')
    const docM = await mk(
      ':- module muser.\n' +
      ':- interface.\n' +
      ':- import_module mpair.\n' +
      ':- pred p(pair(int, int)::out) is det.\n' +
      ':- end_module muser.\n' +
      ':- implementation.\n' +
      'p(P) :- P = 1 - 2.\n',
      'muser-direct',
    )
    await linker.link(docM, {
      isCancellationRequested: false,
      onCancellationRequested: () => undefined,
    } as any)
    const mins = collectTerms(docM.parseResult.value, '-/2')
    expect(mins.length).toBeGreaterThan(0)
    for (const t of mins) expect(t.semanticType).toBe('constructor')
  })

  it('infers higher-order closure head types and disambiguates inner functor', async () => {
    // p 接收 func(A, B) = pair(A, B)；把 func(X, Y) = (X - Y) 直接作为实参传入，
    // 闭包头 X、Y 应被推成 pair 的类型参数，从而内部的 `X - Y` 按 pair 构造子消歧
    const doc = await linkSource(
      ':- module m.\n' +
      ':- interface.\n' +
      ':- type pair(K, V) ---> K - V.\n' +
      ':- pred p(func(A, B) = pair(A, B)::in) is det.\n' +
      ':- end_module m.\n' +
      ':- implementation.\n' +
      'foo :-\n' +
      '    p(func(X, Y) = (X - Y)).\n',
    )
    // 闭包体内的 `X - Y` 应被精确标成 pair 的构造子（而非无类别/func）
    const mins = collectTerms(doc.parseResult.value, '-/2')
    expect(mins.length).toBeGreaterThan(0)
    for (const t of mins) expect(t.semanticType).toBe('constructor')
  })

  it('treats higher-order closure calls as valid calls with output bound by the closure mode', async () => {
    const src = [
      ':- module m.',
      ':- interface.',
      ':- pred run(pred(int, int)::in, int::in, int::out) is det.',
      ':- end_module m.',
      ':- implementation.',
      'run(Closure, In, Out) :-',
      '    In = 1,',
      '    Closure(In, Out).',
    ].join('\n')
    const uri = URI.parse('file:///higher-order-closure-mode.m')
    const doc = await visitDoc(src, uri)
    const modeErrors = doc.visitResult.errors.filter((d: any) => d.source === 'mercury-ls')
    expect(modeErrors).toEqual([])
  })

  it('collects type/func/pred signatures for inference (TypeInfo/FuncInfo)', async () => {
    const v = await visitSource(
      ':- module m.\n' +
      ':- interface.\n' +
      ':- type pair(K, V) ---> K - V.\n' +
      ':- type list(T) ---> [] ; [T | list(T)].\n' +
      ':- func f(int, int) = va.\n' +
      ':- pred p(int::in, int::out) is det.\n' +
      ':- end_module m.\n',
    )
    const types = (v as any).types as Map<string, any>
    // 类型 pair(K, V) → 2 个类型参数，构造子 `-`/2
    const pair = types.get('pair/2')
    expect(pair).toBeTruthy()
    expect(pair.params.length).toBe(2)
    const minusCtor = pair.constructors.find((c: any) => c.ctor === '-')
    expect(minusCtor).toBeTruthy()
    expect(minusCtor.arity).toBe(2)
    // 构造子结果类型 = 所属类型应用其参数 pair(K, V)
    expect(minusCtor.resultType.ctor.name).toBe('pair')
    expect(minusCtor.resultType.args.length).toBe(2)

    // list(T) 的 [] 与 [|] 构造子也收集
    const list = types.get('list/1')
    expect(list.constructors.find((c: any) => c.ctor === '[]')).toBeTruthy()
    expect(list.constructors.find((c: any) => c.ctor === '[|]')).toBeTruthy()

    // func 签名：参数类型 + 返回类型
    const funcs = (v as any).funcs as Map<string, any>
    const f = funcs.get('f/2')
    expect(f).toBeTruthy()
    expect(f.argTypes.length).toBe(2)
    expect(f.resultType.ctor.name).toBe('va')

    // pred 签名：参数类型，无返回类型
    const preds = (v as any).preds as Map<string, any>
    const p = preds.get('p/2')
    expect(p).toBeTruthy()
    expect(p.argTypes.length).toBe(2)
    expect(p.resultType).toBeUndefined()
  })

  it('infers functor category from variable types (pair -/2 as constructor)', async () => {
    const doc = await linkSource(
      ':- module m.\n' +
      ':- interface.\n' +
      ':- type pair(K, V) ---> K - V.\n' +
      ':- pred map_keys_func_2(K::in, V::out, pair(K, V)::in, assoc_list(K, V)::in, list(pair(K, V))::out) is det.\n' +
      ':- implementation.\n' +
      'map_keys_func_2(KeyMap, Tail0, !List) :-\n' +
      '    ( Tail0 = [],\n' +
      '        !:List = []\n' +
      '    ;\n' +
      '        Tail0 = [Key0 - Value | Tail1],\n' +
      '        Key = KeyMap(Value, Key0),\n' +
      '        !:List = [Key - Value | !.List],\n' +
      '        map_keys_func_2(KeyMap, Tail1, !List)\n' +
      '    ).\n',
    )
    // 所有 `-/2` 都出现在 pair 类型的列表元素位置 → 推断为构造子
    const mins = collectTerms(doc.parseResult.value, '-/2')
    expect(mins.length).toBeGreaterThan(0)
    for (const t of mins) {
      expect(t.semanticType).toBe('constructor')
    }
  })

  it('infers assoc_list head arg: [|]/2 and -/2 as constructors, K typed (cross-module synonym)', async () => {
    // mlist 导出 pair(K,V) ---> K - V 与 assoc_list(K,V) == list(pair(K,V)) 同义词
    const mk = async (src: string, name: string) => {
      const uri = URI.parse(`file:///${name}.m`)
      const doc = mercuryDocumentFactory.fromString(src, uri)
      mercuryDocuments.addDocument(doc)
      await new Visitor().visit(doc, {
        isCancellationRequested: false,
        onCancellationRequested: () => undefined,
      } as any)
      const mod = doc.visitResult!.module
      if (mod) moduleManager.set(mod, doc)
      exportManager.set(doc)
      return doc
    }
    await mk(
      ':- module mlist.\n' +
      ':- interface.\n' +
      ':- type pair(K, V) ---> K - V.\n' +
      ':- type assoc_list(K, V) == list(pair(K, V)).\n' +
      ':- end_module mlist.\n',
      'mlist-assoc',
    )
    // muser 导入 mlist，头参数直接写列表语法 [K - V0 | KVs0]；assoc_list 是跨模块同义词
    const docM = await mk(
      ':- module muser.\n' +
      ':- interface.\n' +
      ':- import_module mlist.\n' +
      ':- pred map_values_only(pred(V, W)::in(pred(in, out), det), assoc_list(K, V)::in, assoc_list(K, W)::out) is det.\n' +
      ':- end_module muser.\n' +
      ':- implementation.\n' +
      'map_values_only(_P, [], []).\n' +
      'map_values_only(P, [K - V0 | KVs0], [K - V | KVs]) :-\n' +
      '    P(V0, V).\n',
      'muser-assoc',
    )
    await linker.link(docM, {
      isCancellationRequested: false,
      onCancellationRequested: () => undefined,
    } as any)
    // 列表 cons [|]/2 与元素 pair 构造子 -/2 都应按构造子标注
    const consList = collectTerms(docM.parseResult.value, '[|]/2')
    const minus = collectTerms(docM.parseResult.value, '-/2')
    expect(consList.length).toBeGreaterThan(0)
    for (const t of consList) expect(t.semanticType).toBe('constructor')
    expect(minus.length).toBeGreaterThan(0)
    for (const t of minus) expect(t.semanticType).toBe('constructor')
    // 头变量 K 的类型由 assoc_list(K, V) 同义词展开推为 K，而非 unknown
    const kInfo = [...docM.visitResult!.inferred.entries()].filter(([t]: any) => t.name === 'K')
    expect(kInfo.length).toBeGreaterThan(0)
    for (const [, info] of kInfo) expect(merTypeToString((info as any).type)).toBe('K')
  })

  it('resolves unqualified refs via the global export index (cross-module)', async () => {
    const mk = async (src: string, name: string) => {
      const uri = URI.parse(`file:///${name}.m`)
      const doc = mercuryDocumentFactory.fromString(src, uri)
      mercuryDocuments.addDocument(doc)
      await new Visitor().visit(doc, {
        isCancellationRequested: false,
        onCancellationRequested: () => undefined,
      } as any)
      const mod = doc.visitResult!.module
      if (mod) moduleManager.set(mod, doc)
      exportManager.set(doc)
      return doc
    }
    // va 模块 interface 段导出 empty/0
    await mk(':- module va.\n:- interface.\n:- func empty = int.\n:- end_module va.\n', 'va-mod')
    // t 模块引用 empty，自身无定义：经全局导出索引消解为 func
    const docT = await mk(
      ':- module t.\n:- interface.\n:- import_module va.\n:- end_module t.\n' +
      ':- implementation.\ng(X) :- X = empty.\n',
      't-mod',
    )
    await linker.link(docT, {
      isCancellationRequested: false,
      onCancellationRequested: () => undefined,
    } as any)
    const ref = docT.visitResult!.reference.get('empty')[0]
    expect(ref.semanticType).toBe('func')
  })

  it('goto def resolves expression functors without category labels (func calls)', async () => {
    const src = [
      ':- module t.',
      ':- interface.',
      ':- func init(int, int) = int.',
      ':- end_module t.',
      ':- implementation.',
      'init(N, X) = empty.',
      'f(N, X) = VA :-',
      '    VA0 = init(N, X),',
      '    VA = VA0.',
    ].join('\n')
    const uri = URI.parse('file:///functor-def.m')
    const doc = await visitDoc(src, uri)

    // 表达式位置的 functor 引用（init(N, X)）没有 semanticType
    const refTerm = doc.visitResult!.reference.get('init')[0]
    expect(refTerm.semanticType).toBeUndefined()
    const locs = (await findDefTerms({ uri, term: refTerm } as any))
      .map(uriTermToLocation)
      .toArray()
    expect(locs.length).toBe(1)
    // 命中定义子句头 init(N, X)（第 6 行，0 基 5）
    expect(locs[0].range.start.line).toBe(5)
  })

  it('find references skips same-name terms qualified/resolved to other modules', async () => {
    // 模块 version_array 定义 init/2 并自引用
    const va = await visitDoc(
      [
        ':- module version_array.',
        ':- interface.',
        ':- func init(int, int) = int.',
        ':- end_module version_array.',
        ':- implementation.',
        'init(N, X) = N.',
        'k(X) :- X = init(1, 2).',
      ].join('\n'),
      URI.parse('file:///va.m'),
    )
    // 模块 other：限定引用 version_array.init（保留）、非限定 init（无 import，排除）
    await visitDoc(
      [
        ':- module other.',
        ':- interface.',
        ':- end_module other.',
        ':- implementation.',
        'g(X) :- X = version_array.init(1, 2).',
        'h(X) :- X = init(1, 2).',
      ].join('\n'),
      URI.parse('file:///other.m'),
    )
    // 模块 fourth：import 了 version_array 的非限定引用（保留）
    await visitDoc(
      [
        ':- module fourth.',
        ':- interface.',
        ':- import_module version_array.',
        ':- end_module fourth.',
        ':- implementation.',
        'm(X) :- X = init(1, 2).',
      ].join('\n'),
      URI.parse('file:///fourth.m'),
    )

    const defTerm = va.visitResult!.definition.get('init')[0]
    const refs = await ReferenceProvider({
      textDocument: { uri: va.uri.toString() },
      position: termRange(defTerm).start,
    } as any)
    // va.k 的非限定自引用 + other.g 的 version_array.init 限定引用 + fourth.m（已 import）
    expect(refs.length).toBe(3)
  })

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

  it('goto type definition resolves type refs to the type declaration', async () => {
    const src = [
      ':- module test.',
      ':- interface.',
      ':- type pair(T, U).',
      ':- pred p(pair(int, int)) is det.',
      ':- end_module test.',
      '',
    ].join('\n')
    const uri = URI.parse('file:///type-goto-def.m')
    const doc = await visitDoc(src, uri)

    const refTerm = doc.visitResult!.typeReference.get('pair')[0]
    const locs = await TypeDefinitionProvider({
      textDocument: { uri: uri.toString() },
      position: termRange(refTerm).start,
    } as any)
    expect(locs.length).toBe(1)
    expect(locs[0].range.start.line).toBe(2)
  })

  it('goto type definition resolves imported generic type refs across modules', async () => {
    const pairUri = URI.parse('file:///generic-pair.m')
    const pairDoc = await visitDoc([
      ':- module generic_pair.',
      ':- interface.',
      ':- type pair(T, U).',
      ':- end_module generic_pair.',
      '',
    ].join('\n'), pairUri)
    moduleManager.set(pairDoc.visitResult!.module!, pairDoc)
    exportManager.set(pairDoc)

    const useUri = URI.parse('file:///generic-use.m')
    const useDoc = await visitDoc([
      ':- module generic_use.',
      ':- interface.',
      ':- import_module generic_pair.',
      ':- pred p(pair(int, string)) is det.',
      ':- end_module generic_use.',
      '',
    ].join('\n'), useUri)

    const refTerm = useDoc.visitResult!.typeReference.get('pair')[0]
    const locs = await TypeDefinitionProvider({
      textDocument: { uri: useUri.toString() },
      position: termRange(refTerm).start,
    } as any)
    expect(locs.length).toBe(1)
    expect(locs[0].uri).toBe(pairUri.toString())
    expect(locs[0].range.start.line).toBe(2)
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

  it('scanHeader extracts module name and import_module targets', () => {
    const src = [
      ':- module muser.',
      ':- interface.',
      ':- import_module mpair, mlist.',
      ':- import_module mset.',
      ':- end_module muser.',
    ].join('\n')
    const h = scanHeader(Parser.parse(src).value as any)
    expect(h.module).toBe('muser')
    // 逗号形式 mpair, mlist 与单独 import_module mset 都要抽到
    expect(h.imports.sort()).toEqual(['mlist', 'mpair', 'mset'])
  })

  it('orderByImports orders import targets before importers', () => {
    const docs = [
      { name: 'muser', imports: ['mpair', 'mlist'] },
      { name: 'mpair', imports: [] },
      { name: 'mlist', imports: ['mpair'] },
      { name: 'orphan', imports: [] },
    ]
    const ordered = orderByImports(
      docs,
      d => d.name,
      d => d.imports,
    )
    const pos = (n: string) => ordered.findIndex(d => d.name === n)
    // mpair 必须排在依赖它的 muser / mlist 之前
    expect(pos('mpair')).toBeLessThan(pos('muser'))
    expect(pos('mpair')).toBeLessThan(pos('mlist'))
    // 依赖目标不在批次（如 external）时不影响顺序，orphan 仍出现
    expect(ordered.map(d => d.name)).toContain('orphan')
  })
})

describe('hover shows inferred types', () => {
  const visitDoc = async (src: string, uri: URI) => {
    const doc = mercuryDocumentFactory.fromString(src, uri)
    mercuryDocuments.addDocument(doc)
    await new Visitor().visit(doc, {
      isCancellationRequested: false,
      onCancellationRequested: () => undefined,
    } as any)
    return doc
  }
  it('shows full signature for a func reference', async () => {
    const src = [
      ':- module m.',
      ':- interface.',
      ':- func add(int::in, int::in) = int.',
      ':- end_module m.',
      ':- implementation.',
      'g(Z) :- Z = add(1, 2).',
    ].join('\n')
    const uri = URI.parse('file:///hover-func.m')
    const doc = await visitDoc(src, uri)
    const addRef = collectTerms(doc.parseResult.value, 'add/2')
      .find((t: any) => t.semanticType === 'func')
    expect(addRef).toBeTruthy()
    const hover = await HoverProvider({
      textDocument: { uri: uri.toString() },
      position: termRange(addRef).start,
    } as any)
    const value: string = (hover!.contents as any).value
    expect(value).toContain('(func) add/2')
    // 第二行：type + 类型签名（不带 mode）；第三行：mode + mode 声明
    expect(value).toContain('type add(int, int) = int')
    expect(value).toContain('mode add(in, in) = (out)')
    expect(value).not.toContain('::')
  })

  it('shows argument modes in func/pred signature hover', async () => {
    const src = [
      ':- module m.',
      ':- interface.',
      ':- pred q(int :: in(i_node)) is det.',
      ':- func f(int::in) = (int::out) is det.',
      ':- end_module m.',
    ].join('\n')
    const uri = URI.parse('file:///hover-mode.m')
    const doc = await visitDoc(src, uri)
    const hoverOf = async (nameArity: string) => {
      const t = collectTerms(doc.parseResult.value, nameArity)
        .find((x: any) => x.semanticType === 'pred' || x.semanticType === 'func')
      const h = await HoverProvider({
        textDocument: { uri: uri.toString() },
        position: termRange(t).start,
      } as any)
      return (h!.contents as any).value as string
    }
    // 类型行 + mode 行（复合 mode in(i_node) 原样渲染；mode 行带 determinism）
    const q = await hoverOf('q/1')
    expect(q).toContain('(pred) q/1')
    expect(q).toContain('type q(int)')
    expect(q).toContain('mode q(in(i_node)) is det')
    const f = await hoverOf('f/1')
    expect(f).toContain('(func) f/1')
    expect(f).toContain('type f(int) = int')
    expect(f).toContain('mode f(in) = (out) is det')
  })

  it('shows owning type in constructor hover', async () => {
    const src = [
      ':- module m.',
      ':- interface.',
      ':- type tree(T) ---> leaf ; node(T, tree(T)).',
      ':- type unit ---> u.',
      ':- end_module m.',
    ].join('\n')
    const uri = URI.parse('file:///hover-ctor.m')
    const doc = await visitDoc(src, uri)
    const hoverOf = async (nameArity: string) => {
      const t = collectTerms(doc.parseResult.value, nameArity)
        .find((x: any) => x.semanticType === 'constructor')
      const h = await HoverProvider({
        textDocument: { uri: uri.toString() },
        position: termRange(t).start,
      } as any)
      return (h!.contents as any).value as string
    }
    // 构造子签名：参数 = 结果类型（所属类型）
    expect(await hoverOf('node/2')).toContain('type node(T, tree(T)) = tree(T)')
    // 零元构造子不带空括号
    expect(await hoverOf('u/0')).toContain('type u = unit')
  })

  it('infers variable types inside if-then-else branches from head signature', async () => {
    const src = [
      ':- module m.',
      ':- interface.',
      ':- pred p(int::in) is det.',
      ':- end_module m.',
      ':- implementation.',
      'p(X) :- ( if X > 0 then Y = X else true ).',
    ].join('\n')
    const uri = URI.parse('file:///hover-if.m')
    const doc = await visitDoc(src, uri)
    // Y 只出现在 then 分支：应与 head 参数 X 同为 int（此前 then 分支被当数据推断而 unknown）
    const ys = [...doc.visitResult.inferred.entries()].filter(([t]: any) => t.name === 'Y')
    expect(ys.length).toBeGreaterThan(0)
    for (const [, info] of ys) {
      expect(merTypeToString((info as any).type)).toBe('int')
    }
  })

  it('mode analysis Phase A: parses inst/mode declarations into structured MerInst', async () => {
    const src = [
      ':- module m.',
      ':- interface.',
      ':- inst list_skel ---> [] ; [X | list_skel].',
      ':- inst pair_cell(T) ---> pair(T, T).',
      ':- inst i2 == ground.',
      ':- mode di_uo == ground >> ground.',
      ':- pred q(int::in) is det.',
      ':- func f(int::in) = (int::out).',
      ':- end_module m.',
    ].join('\n')
    const uri = URI.parse('file:///mode-phase-a.m')
    const doc = await visitDoc(src, uri)
    // `--->` 体 → bound 构造子列表；body 里的变量 → inst_var 形参引用
    expect(doc.visitResult.instDefs.get('list_skel/0')).toEqual({
      params: [],
      body: {
        kind: 'bound',
        functors: [
          { ctor: '[]', arity: 0, args: [] },
          { ctor: '[|]', arity: 2, args: [
            { kind: 'inst_var', name: 'X' },
            { kind: 'user', name: 'list_skel', arity: 0, args: [] },
          ] },
        ],
      },
    })
    // 参数化 inst：形参名记入 params
    expect(doc.visitResult.instDefs.get('pair_cell/1')).toEqual({
      params: ['T'],
      body: {
        kind: 'bound',
        functors: [{ ctor: 'pair', arity: 2, args: [
          { kind: 'inst_var', name: 'T' }, { kind: 'inst_var', name: 'T' },
        ] }],
      },
    })
    expect(doc.visitResult.instDefs.get('i2/0')).toEqual({ params: [], body: { kind: 'ground' } })
    expect(doc.visitResult.modeDefs.get('di_uo/0')).toEqual({
      params: [], initial: { kind: 'ground' }, final: { kind: 'ground' },
    })
    // 声明参数 → 结构化 mode 引用（未注解默认 in / 返回默认 out）
    expect(doc.visitResult.preds.get('q/1')?.argModeRefs).toEqual([
      { kind: 'builtin', name: 'in', args: [] },
    ])
    expect(doc.visitResult.funcs.get('f/1')?.argModeRefs).toEqual([
      { kind: 'builtin', name: 'in', args: [] },
    ])
    expect(doc.visitResult.funcs.get('f/1')?.resultModeRef).toEqual({
      kind: 'builtin', name: 'out', args: [],
    })
    // 用户 mode 解析（形参替换在 modeRefToInsts）
    const ref = doc.visitResult.preds.get('q/1')?.argModeRefs?.[0]
    const insts = ref && modeRefToInsts(ref, doc.visitResult.modeDefs)
    expect(insts).toEqual({ initial: { kind: 'ground' }, final: { kind: 'ground' } })
  })

  it('infers higher-order closure variables from qualified calls like array.map', async () => {
    const mk = async (src: string, name: string) => {
      const doc = mercuryDocumentFactory.fromString(src, URI.parse(`file:///${name}.m`))
      mercuryDocuments.addDocument(doc)
      await new Visitor().visit(doc, {
        isCancellationRequested: false,
        onCancellationRequested: () => undefined,
      } as any)
      const mod = doc.visitResult!.module
      if (mod) moduleManager.set(mod, doc)
      exportManager.set(doc)
      return doc
    }
    await mk(':- module array.\n:- interface.\n:- pred map(pred(int, int), list(int), list(int)) is det.\n:- end_module array.\n', 'array-hocall')
    const src = [
      ':- module m.',
      ':- interface.',
      ':- func map(func(int) = int, list(int)) = list(int).',
      ':- end_module m.',
      ':- implementation.',
      'map(F, A1) = A2 :-',
      '    P = (pred(X::in, Y::out) is det :- Y = F(X)),',
      '    array.map(P, A1, A2).',
    ].join('\n')
    const doc = await mk(src, 'm-hocall')
    const pInfos = [...doc.visitResult.inferred.entries()].filter(([t]: any) => t.name === 'P')
    expect(pInfos.length).toBeGreaterThan(0)
    expect(merTypeToString((pInfos.at(-1)![1] as any).type)).toBe('pred(int, int)')
  })

  it('resolves module-qualified function calls in type inference (uint.cast_to_int)', async () => {
    const mk = async (src: string, name: string) => {
      const doc = mercuryDocumentFactory.fromString(src, URI.parse(`file:///${name}.m`))
      mercuryDocuments.addDocument(doc)
      await new Visitor().visit(doc, {
        isCancellationRequested: false,
        onCancellationRequested: () => undefined,
      } as any)
      const mod = doc.visitResult!.module
      if (mod) moduleManager.set(mod, doc)
      exportManager.set(doc)
      return doc
    }
    // 标准库风格：uint 模块导出 cast_to_int/1（模拟 library/uint.m 被构建后的导出索引）
    await mk(':- module uint.\n:- interface.\n:- func cast_to_int(uint) = int.\n:- end_module uint.\n', 'uint-mod')
    const src = [
      ':- module m.',
      ':- interface.',
      ':- pred uinit(uint::in) is det.',
      ':- end_module m.',
      ':- implementation.',
      'uinit(Size) :-',
      '    SizeI = uint.cast_to_int(Size),',
      '    SizeI > 0.',
    ].join('\n')
    const doc = await mk(src, 'm-qualcall')
    await linker.link(doc, {
      isCancellationRequested: false,
      onCancellationRequested: () => undefined,
    } as any)
    const infoOf = (name: string) =>
      [...doc.visitResult.inferred.entries()].filter(([t]: any) => t.name === name)
    // 修复前：./2 被当名为 `.` 的 functor 查不到 → SizeI/cast_to_int 均为 unknown
    // 修复后：按限定模块 uint 精确查 cast_to_int/1 签名 → SizeI 推为 int
    const sis = infoOf('SizeI')
    expect(sis.length).toBeGreaterThan(0)
    for (const [, info] of sis) expect(merTypeToString((info as any).type)).toBe('int')
    // cast_to_int 本身消解为 func，类型 int
    const ctis = infoOf('cast_to_int')
    expect(ctis.length).toBeGreaterThan(0)
    for (const [, info] of ctis) {
      expect((info as any).category).toBe('func')
      expect(merTypeToString((info as any).type)).toBe('int')
    }
    // 参数 Size 经签名对齐仍为 uint（从头签名来）
    const sizes = infoOf('Size')
    for (const [, info] of sizes) expect(merTypeToString((info as any).type)).toBe('uint')
    // hover：跨模块 func 引用显示签名 + mode 行（来自导出签名的 argModeRefs）
    const ctTerm = ctis[0][0]
    const hover = await HoverProvider({
      textDocument: { uri: doc.uri.toString() },
      position: termRange(ctTerm).start,
    } as any)
    const value: string = (hover!.contents as any).value
    expect(value).toContain('type cast_to_int(uint) = int')
    expect(value).toContain('mode cast_to_int(in) = (out)')
  })

  it('binds a function result variable from a qualified output call', async () => {
    const mk = async (src: string, name: string) => {
      const doc = mercuryDocumentFactory.fromString(src, URI.parse(`file:///${name}.m`))
      mercuryDocuments.addDocument(doc)
      await new Visitor().visit(doc, {
        isCancellationRequested: false,
        onCancellationRequested: () => undefined,
      } as any)
      const mod = doc.visitResult!.module
      if (mod) moduleManager.set(mod, doc)
      exportManager.set(doc)
      return doc
    }
    await mk([
      ':- module assoc_list.',
      ':- interface.',
      ':- pred from_corresponding_lists(list(K), list(V), assoc_list(K, V)).',
      ':- mode from_corresponding_lists(in, in, out) is det.',
      ':- end_module assoc_list.',
    ].join('\n'), 'assoc-list')
    const src = [
      ':- module m.',
      ':- interface.',
      ':- func from_corresponding_lists(list(K), list(V)) = assoc_list(K, V).',
      ':- mode from_corresponding_lists(in, in) = (out) is det.',
      ':- end_module m.',
      ':- implementation.',
      'from_corresponding_lists(Ks, Vs) = AL :-',
      '    assoc_list.from_corresponding_lists(Ks, Vs, AL).',
    ].join('\n')
    const doc = await mk(src, 'm-qualified-result')
    const errors = doc.visitResult.errors.filter((d: any) => d.source === 'mercury-ls')
    expect(errors).toEqual([])
  })

  it('binds an output argument from a same-module qualified output call before module registration', async () => {
    const moduleName = 'bag_q_solo'
    const src = [
      `:- module ${moduleName}.`,
      ':- interface.',
      `:- type ${moduleName}(T).`,
      `:- pred init(${moduleName}(T)::out) is det.`,
      `:- end_module ${moduleName}.`,
      ':- implementation.',
      'init(Bag) :-',
      `    ${moduleName}.init(Bag).`,
    ].join('\n')
    const doc: any = {
      parseResult: Parser.parse(src),
      uri: URI.parse('file:///bag-qualified-solo.m'),
      visitResult: undefined,
    }
    const v = new Visitor()
    await v.visit(doc, {
      isCancellationRequested: false,
      onCancellationRequested: () => undefined,
    } as any)
    const errors = doc.visitResult.errors.filter((d: any) => d.source === 'mercury-ls')
    expect(errors).toEqual([])
  })

  it('pred-mode declaration `:- mode P(Modes) is Det.` replaces the default mode line and sig', async () => {
    const src = [
      ':- module m.',
      ':- interface.',
      ':- pred lookup(array(T), int, T).',
      ':- mode lookup(in, in, out) is det.',
      ':- pred q(array(int)::in, int::in, int::out).',
      ':- end_module m.',
      ':- implementation.',
      'lookup(A, I, X) :- X = 5.',
      'q(A, I, X) :- lookup(A, I, X).',
    ].join('\n')
    const uri = URI.parse('file:///mode-predmode.m')
    const doc = await visitDoc(src, uri)
    const vr = doc.visitResult
    // hover modeSigs：显式声明替换默认行（默认 in,in,in 是无注解 pred 声明的推断，不再显示）
    const sigs = vr.modeSigs.get('lookup/3') ?? []
    expect(sigs).toEqual(['lookup(in, in, out) is det'])
    // 签名 argModeRefs 覆盖为声明值（mode checker 调用检查随之使用 in,in,out）
    expect(vr.preds.get('lookup/3')?.argModeRefs).toEqual([
      { kind: 'builtin', name: 'in', args: [] },
      { kind: 'builtin', name: 'in', args: [] },
      { kind: 'builtin', name: 'out', args: [] },
    ])
    // q 调用 lookup(A, I, X)：X 自由匹配 out（若无覆盖会误报 no-matching-mode）
    const modeErrors = vr.errors.filter((d: any) => d.source === 'mercury-ls')
    expect(modeErrors).toEqual([])
  })

  it('state variable expansion in calls: function-goal form and distinct !./!: components', async () => {
    const src = [
      ':- module m.',
      ':- interface.',
      ':- func slow_set(int, int, int) = int.',
      ':- pred bump(int::in, int::out) is det.',
      ':- pred pb(int::in) is det.',
      ':- end_module m.',
      ':- implementation.',
      // 函数形式糖：slow_set(N, X, !A) → !:A = slow_set(N, X, !.A)
      'slow_set(!.A, N, X) = !:A :-',
      '    slow_set(N, X, !A).',
      'bump(X, Y) :- Y is X + 1.',
      // 谓词形式：bump(!N) → bump(!.N, !:N)
      'pb(!.N) :- bump(!N).',
    ].join('\n')
    const uri = URI.parse('file:///mode-statevar.m')
    const doc = await visitDoc(src, uri)
    const modeErrors = doc.visitResult.errors.filter((d: any) => d.source === 'mercury-ls')
    // 修复前：!.A / !:A 共用一个变量键（head 里 in/out 初始化互相覆盖成 free），
    // 且调用按书写元数 slow_set/3 查签名、!A 不展开 → no-matching-mode（用户报告的现象）
    expect(modeErrors).toEqual([])
  })

  it('binds output args through qualified state-variable calls', async () => {
    const mk = async (src: string, name: string) => {
      const doc = mercuryDocumentFactory.fromString(src, URI.parse(`file:///${name}.m`))
      mercuryDocuments.addDocument(doc)
      await new Visitor().visit(doc, {
        isCancellationRequested: false,
        onCancellationRequested: () => undefined,
      } as any)
      const mod = doc.visitResult!.module
      if (mod) moduleManager.set(mod, doc)
      exportManager.set(doc)
      return doc
    }
    await mk([
      ':- module tree234.',
      ':- interface.',
      ':- pred remove_smallest(T::out, int::in, !Map) is det.',
      ':- mode remove_smallest(out, in, in, out) is det.',
      ':- end_module tree234.',
    ].join('\n'), 'tree234-statevar')
    const doc = await mk([
      ':- module m.',
      ':- interface.',
      ':- import_module tree234.',
      ':- pred wrapper(T::out, int::in, !Map) is det.',
      ':- mode wrapper(out, in, in, out) is det.',
      ':- end_module m.',
      ':- implementation.',
      'wrapper(K, V, !Map) :-',
      '    tree234.remove_smallest(K, V, !Map).',
    ].join('\n'), 'm-statevar-call')
    const modeErrors = doc.visitResult.errors.filter((d: any) => d.source === 'mercury-ls')
    expect(modeErrors).toEqual([])
  })

  it('treats state-variable output in empty list fold case as bound at clause end', async () => {
    const src = [
      ':- module m.',
      ':- interface.',
      ':- pred foldl(pred(T, U, U), list(T), !U) is det.',
      ':- end_module m.',
      ':- implementation.',
      'foldl(_P, [], !A).',
    ].join('\n')
    const doc = mercuryDocumentFactory.fromString(src, URI.parse('file:///foldl-statevar.m'))
    mercuryDocuments.addDocument(doc)
    await new Visitor().visit(doc, {
      isCancellationRequested: false,
      onCancellationRequested: () => undefined,
    } as any)
    const modeErrors = doc.visitResult.errors.filter((d: any) => d.source === 'mercury-ls')
    expect(modeErrors).toEqual([])
  })

  it('head-domain type of KVs follows the pred signature on recursive update', async () => {
    const mk = async (src: string, name: string) => {
      const doc = mercuryDocumentFactory.fromString(src, URI.parse(`file:///${name}.m`))
      mercuryDocuments.addDocument(doc)
      await new Visitor().visit(doc, {
        isCancellationRequested: false,
        onCancellationRequested: () => undefined,
      } as any)
      const mod = doc.visitResult!.module
      if (mod) moduleManager.set(mod, doc)
      exportManager.set(doc)
      return doc
    }
    await mk(':- module pair.\n:- interface.\n:- type pair(K, V) ---> K - V.\n:- end_module pair.\n', 'pair-imported-head')
    await mk(':- module assoc_list.\n:- interface.\n:- import_module pair.\n:- type assoc_list(K, V) == list(pair(K, V)).\n:- end_module assoc_list.\n', 'assoc-list-head')
    const src = [
      ':- module m.',
      ':- interface.',
      ':- import_module assoc_list.',
      ':- pred update(K, V, assoc_list(K, V), assoc_list(K, V)).',
      ':- mode update(in, in, in, out) is det.',
      ':- end_module m.',
      ':- implementation.',
      'update(Key, Value, KVs0, KVs) :-',
      '    KVs0 = [K - V | TailKVs0],',
      '    KVs = [K - V | TailKVs0].',
    ].join('\n')
    const doc = await mk(src, 'update-head-type')
    const kvs = [...doc.visitResult.inferred.entries()].filter(([t]: any) => t.name === 'KVs')
    const kvTypes = kvs.map(([, info]: any) => merTypeToString(info.type))
    expect(kvTypes).toContain('assoc_list(K, V)')
  })

  it('qualified calls resolve signatures from the qualified module (mode checker)', async () => {
    const mk = async (src: string, name: string) => {
      const doc = mercuryDocumentFactory.fromString(src, URI.parse(`file:///${name}.m`))
      mercuryDocuments.addDocument(doc)
      await new Visitor().visit(doc, {
        isCancellationRequested: false,
        onCancellationRequested: () => undefined,
      } as any)
      const mod = doc.visitResult!.module
      if (mod) moduleManager.set(mod, doc)
      exportManager.set(doc)
      return doc
    }
    // array 模块导出 size/2 (in, in)；本地模块也有同名 size/2 (out, out)
    await mk(':- module array.\n:- interface.\n:- pred size(int::in, int::in) is semidet.\n:- end_module array.\n', 'array-sv')
    const src = [
      ':- module m.',
      ':- interface.',
      ':- pred size(int::out, int::out) is det.',
      ':- pred is_empty(int::in) is semidet.',
      ':- end_module m.',
      ':- implementation.',
      // 修复前：checker 按裸名 size/2 查到本地 (out,out)，Array ground vs out initial free → 误报
      // 修复后：限定调用按 array 模块精确查 (in,in) → 匹配，零诊断
      'is_empty(Array) :-',
      '    array.size(Array, 0).',
    ].join('\n')
    const doc = await mk(src, 'm-qualcheck')
    const modeErrors = doc.visitResult.errors.filter((d: any) => d.source === 'mercury-ls')
    expect(modeErrors).toEqual([])
  })

  it('out-position args accept bound terms (post-call unification): size(Array, 0)', async () => {
    // 模拟 mercury/library/array.m：
    //   :- pred size(array(_T), int).
    //   :- mode size(in, out) is det.
    // 调用 array.size(Array, 0) 把绑定常量传给 out 位——编译器语义为调用后合一，合法
    const mk = async (src: string, name: string) => {
      const doc = mercuryDocumentFactory.fromString(src, URI.parse(`file:///${name}.m`))
      mercuryDocuments.addDocument(doc)
      await new Visitor().visit(doc, {
        isCancellationRequested: false,
        onCancellationRequested: () => undefined,
      } as any)
      const mod = doc.visitResult!.module
      if (mod) moduleManager.set(mod, doc)
      exportManager.set(doc)
      return doc
    }
    await mk(':- module array.\n:- interface.\n:- pred size(int, int).\n:- mode size(in, out) is det.\n:- end_module array.\n', 'array-sz')
    const src = [
      ':- module m.',
      ':- interface.',
      ':- pred is_empty(int::in) is semidet.',
      ':- end_module m.',
      ':- implementation.',
      'is_empty(Array) :-',
      '    array.size(Array, 0).',
    ].join('\n')
    const doc = await mk(src, 'm-sizezero')
    const modeErrors = doc.visitResult.errors.filter((d: any) => d.source === 'mercury-ls')
    expect(modeErrors).toEqual([])
  })

  it('infers func-clause head params and result from the signature (f(X)=Z :- Body)', async () => {
    const src = [
      ':- module m.',
      ':- interface.',
      ':- func add(int::in, int::in) = int.',
      ':- end_module m.',
      ':- implementation.',
      'add(X, Y) = Z :- Z = X + Y.',
    ].join('\n')
    const uri = URI.parse('file:///hover-func-body.m')
    const doc = await visitDoc(src, uri)
    const typedAsInt = (name: string) =>
      [...doc.visitResult.inferred.entries()].filter(
        ([t, info]: any) => t.name === name && info.type && merTypeToString(info.type) === 'int',
      )
    // 带体函数子句：头参数 X/Y 与结果变量 Z 都按签名推成 int
    expect(typedAsInt('X').length).toBeGreaterThan(0)
    expect(typedAsInt('Y').length).toBeGreaterThan(0)
    expect(typedAsInt('Z').length).toBeGreaterThan(0)
  })
})
