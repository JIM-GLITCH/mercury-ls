import { beforeEach, describe, it, expect } from 'vitest'
import { URI } from 'vscode-uri'
import { Visitor } from '../document-visitor'
import { createMercuryServices, type MercuryServices } from '../services'
import { merTypeToString } from '../document-type'

let services: MercuryServices
beforeEach(() => {
  services = createMercuryServices()
})

async function mk(src: string, name: string) {
  const uri = URI.parse(`file:///${name}.m`)
  const doc = services.documentFactory.fromString(src, uri)
  services.documents.addDocument(doc)
  await new Visitor(services).visit(doc, {
    isCancellationRequested: false,
    onCancellationRequested: () => undefined,
  } as any)
  const mod = doc.visitResult!.module
  if (mod) services.moduleManager.set(mod, doc)
  services.exportManager.set(doc)
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

// 回归：inferGoal 必须处理 is/2。缺失时 is/2 掉进 default 被当数据 functor，
// `S is array.size(L)` 的 S 永远 unknown，而 RHS 作为参数仍能推出类型。
describe('is/2 goal inference', () => {
  it('S is array.size(L) infers S from qualified func result', async () => {
    await mk(
      ':- module array.\n' +
      ':- interface.\n' +
      ':- func size(list(T)) = int is det.\n' +
      ':- end_module array.\n',
      'array',
    )
    const docM = await mk(
      ':- module m.\n' +
      ':- interface.\n' +
      ':- implementation.\n' +
      ':- import_module array.\n' +
      'p(L, S) :- S is array.size(L).\n' +
      ':- end_module m.\n',
      'm',
    )
    const inf = docM.visitResult!.inferred
    const sTerms = collectTerms(docM.parseResult.value, 'S/0').filter((t: any) => inf.get(t))
    expect(sTerms.length).toBeGreaterThan(0)
    for (const t of sTerms) expect(merTypeToString((inf.get(t) as any).type)).toBe('int')
    // RHS 调用项同样应标 func 并推出 int
    const sizeTerms = collectTerms(docM.parseResult.value, 'size/1').filter((t: any) => inf.get(t))
    expect(sizeTerms.length).toBeGreaterThan(0)
    for (const t of sizeTerms) {
      expect((inf.get(t) as any)?.category).toBe('func')
      expect(merTypeToString((inf.get(t) as any).type)).toBe('int')
    }
  })

  it('X is Y + 1 propagates through func signature when available', async () => {
    const doc = await mk(
      ':- module t2.\n' +
      ':- interface.\n' +
      ':- func plus(int, int) = int is det.\n' +
      ':- end_module t2.\n',
      't2',
    )
    void doc
    const docM = await mk(
      ':- module m2.\n' +
      ':- interface.\n' +
      ':- implementation.\n' +
      ':- import_module t2.\n' +
      'p(A, B, X) :- X is t2.plus(A, B).\n' +
      ':- end_module m2.\n',
      'm2',
    )
    const inf = docM.visitResult!.inferred
    const xTerms = collectTerms(docM.parseResult.value, 'X/0').filter((t: any) => inf.get(t))
    expect(xTerms.length).toBeGreaterThan(0)
    for (const t of xTerms) expect(merTypeToString((inf.get(t) as any).type)).toBe('int')
  })
})
