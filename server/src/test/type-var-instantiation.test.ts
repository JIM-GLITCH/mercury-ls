import { beforeEach, describe, it, expect } from 'vitest'
import { URI } from 'vscode-uri'
import { Parser } from '../mercury-parser'
import { Visitor } from '../document-visitor'
import { createMercuryServices, type MercuryServices } from '../services'
import { merTypeToString } from '../document-type'

let services: MercuryServices
beforeEach(() => {
  services = createMercuryServices()
})

async function visitSource(src: string) {
  const doc: any = {
    parseResult: Parser.parse(src),
    uri: URI.parse('file:///test.m'),
    visitResult: undefined,
  }
  const v = new Visitor(services)
  await v.visit(doc, {
    isCancellationRequested: false,
    onCancellationRequested: () => undefined,
  } as any)
  return doc
}

function collectTerms(root: any, nameArity: string): any[] {
  const out: any[] = []
  const walk = (t: any) => {
    if (t && typeof t === 'object' && 'nameArity' in t) {
      if (t.nameArity === nameArity) out.push(t)
      if (Array.isArray(t.args)) t.args.forEach(walk)
    }
  }
  walk(root)
  return out
}

// 回归：声明级类型变量必须按「每次使用」实例化。
// 否则同一子句内不同实例共享 subst 里的同名绑定互相污染。
describe('type variable instantiation per use', () => {
  it('two constructors of same polymorphic type with different expected args', async () => {
    const doc = await visitSource(
      ':- module test.\n' +
      ':- interface.\n' +
      ':- type t(T) ---> t1(T) ; t2(T).\n' +
      ':- pred p(t(int), t(string)).\n' +
      ':- implementation.\n' +
      'p(A, B) :- A = t1(X), B = t2(Y).\n' +
      ':- end_module test.\n'
    )
    const inf = doc.visitResult!.inferred
    // t1 先用会把类型参数 T 绑成 int；t2 的 T 必须是独立实例，仍能合上 t(string)
    const t1Body = collectTerms(doc.parseResult.value, 't1/1').filter((t: any) => inf.get(t))
    const t2Body = collectTerms(doc.parseResult.value, 't2/1').filter((t: any) => inf.get(t))
    expect(t1Body.length).toBeGreaterThan(0)
    expect(t2Body.length).toBeGreaterThan(0)
    for (const t of t1Body) {
      expect((inf.get(t) as any)?.category).toBe('constructor')
      expect(merTypeToString((inf.get(t) as any).type)).toBe('test.t(int)')
    }
    for (const t of t2Body) {
      expect((inf.get(t) as any)?.category).toBe('constructor')
      expect(merTypeToString((inf.get(t) as any).type)).toBe('test.t(string)')
    }
    // Y 应推出 string
    const yBody = collectTerms(doc.parseResult.value, 'Y/0').filter((t: any) => inf.get(t))
    expect(yBody.length).toBeGreaterThan(0)
    for (const t of yBody) expect(merTypeToString((inf.get(t) as any).type)).toBe('string')
  })

  it('same polymorphic pred called twice instantiates independently', async () => {
    const doc = await visitSource(
      ':- module test.\n' +
      ':- interface.\n' +
      ':- pred q(T).\n' +
      ':- implementation.\n' +
      'p(X, Y) :- q(X), q(Y), X = 1, Y = "a".\n' +
      ':- end_module test.\n'
    )
    const inf = doc.visitResult!.inferred
    // 两次 q 调用是独立实例：X=int、Y=string，不应被强制同型
    const xBody = collectTerms(doc.parseResult.value, 'X/0').filter((t: any) => inf.get(t))
    const yBody = collectTerms(doc.parseResult.value, 'Y/0').filter((t: any) => inf.get(t))
    expect(xBody.length).toBeGreaterThan(0)
    expect(yBody.length).toBeGreaterThan(0)
    for (const t of xBody) expect(merTypeToString((inf.get(t) as any).type)).toBe('int')
    for (const t of yBody) expect(merTypeToString((inf.get(t) as any).type)).toBe('string')
  })
})
