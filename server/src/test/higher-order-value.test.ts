import { beforeEach, describe, expect, it } from 'vitest'
import { URI } from 'vscode-uri'
import { createMercuryServices, type MercuryServices } from '../services'
import { termTokenRange } from '../utils'
import { merTypeToString } from '../document-type'

let services: MercuryServices
beforeEach(() => { services = createMercuryServices() })

const token = {
  isCancellationRequested: false,
  onCancellationRequested: () => undefined,
} as any

function add(src: string, name: string) {
  const doc = services.documentFactory.fromString(src, URI.parse(`file:///${name}.m`))
  services.documents.addDocument(doc)
  return doc
}

function collect(root: any, pred: (t: any) => boolean, acc: any[] = []): any[] {
  if (!root) return acc
  if (pred(root)) acc.push(root)
  for (const a of root.args ?? []) collect(a, pred, acc)
  return acc
}

function typeOf(doc: any, t: any): string | undefined {
  const info = services.index.get(doc)!.inferred.get(t)
  return info ? merTypeToString(info.type) : undefined
}

describe('higher-order pred/func values', () => {
  it('resolves the nullary atom g in `G = g` to the declared pred g/1', async () => {
    const doc = add([
      ':- pred g(int).',
      ':- pred f(int).',
      'f(X) :-',
      '  G = g,',
      '  G(X).',
    ].join('\n'), 'ho')
    await services.builder.build([doc], token)

    const g = collect(doc.parseResult.value, (t: any) => t.nameArity === 'g/0')[0]
    const G = collect(doc.parseResult.value, (t: any) => t.syntaxType === 'variable' && t.name === 'G')[0]
    expect(g).toBeDefined()
    // 语法 arity 是 0，但语义上引用的是 :- pred g(int)，goto def 要能按 g/1 命中声明
    expect(g.semanticType).toBe('pred')
    expect(g.semanticArity).toBe(1)
    expect(typeOf(doc, g)).toBe('pred(int)')
    expect(services.index.get(doc)!.inferred.get(g)!.category).toBe('pred')
    // 高阶值经 unify 传给变量 G，G(X) 才能按 pred(int) 解析实参
    expect(typeOf(doc, G)).toBe('pred(int)')

    const params = {
      textDocument: { uri: doc.uri.toString() },
      position: termTokenRange(g).start,
    }
    const hover: any = await services.providers.hover(params as any)
    expect(hover.contents.value).toContain('(pred) g/1')
    expect(hover.contents.value).toContain('type g(int)')
    const defs: any = await services.providers.definition(params as any)
    expect(defs?.length).toBeGreaterThan(0)
  })

  it('does not mislabel a nullary constructor as a higher-order value', async () => {
    const doc = add([
      ':- type t ---> leaf ; node(int).',
      ':- pred f(t).',
      'f(X) :- X = leaf.',
    ].join('\n'), 'cons')
    await services.builder.build([doc], token)

    // 取子句体里的引用（而不是类型定义 `---> leaf` 里的构造子定义项）
    const leaf = [...services.index.get(doc)!.reference.get('leaf')][0]
    expect(leaf).toBeDefined()
    expect(leaf.semanticType).toBe('constructor')
    expect(typeOf(doc, leaf)).toBe('t')
  })

  it('resolves the partial application `G = g(1)` to pred(int)', async () => {
    const doc = add([
      ':- pred g(int,int).',
      ':- pred f(int).',
      'f(X):-',
      '  G = g(1),',
      '  G(X).',
    ].join('\n'), 'ho2')
    await services.builder.build([doc], token)

    const g = collect(doc.parseResult.value, (t: any) => t.nameArity === 'g/1')[0]
    const G = collect(doc.parseResult.value, (t: any) => t.syntaxType === 'variable' && t.name === 'G')[0]
    expect(g).toBeDefined()
    // 语法 arity 1，语义上引用 :- pred g(int,int)，剩余 1 个参数构成谓词值
    expect(g.semanticType).toBe('pred')
    expect(g.semanticArity).toBe(2)
    expect(typeOf(doc, g)).toBe('pred(int)')
    expect(services.index.get(doc)!.inferred.get(g)!.category).toBe('pred')
    expect(typeOf(doc, G)).toBe('pred(int)')

    const params = {
      textDocument: { uri: doc.uri.toString() },
      position: termTokenRange(g).start,
    }
    const hover: any = await services.providers.hover(params as any)
    expect(hover.contents.value).toContain('(pred) g/2')
    expect(hover.contents.value).toContain('type g(int, int)')
    const defs: any = await services.providers.definition(params as any)
    expect(defs?.length).toBeGreaterThan(0)
  })

  it('keeps the return type for a partially applied func value', async () => {
    const doc = add([
      ':- func h(int,int) = int.',
      ':- pred p(int).',
      'p(X) :- F = h(1), X = 1.',
    ].join('\n'), 'hofunc')
    await services.builder.build([doc], token)

    const h = collect(doc.parseResult.value, (t: any) => t.nameArity === 'h/1')[0]
    expect(h).toBeDefined()
    expect(h.semanticType).toBe('func')
    expect(h.semanticArity).toBe(2)
    expect(typeOf(doc, h)).toBe('func(int) = int')
  })
})
