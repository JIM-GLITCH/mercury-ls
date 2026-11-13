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

// 回归：同名同元数重载（如 int.+/2 与 uint8.+/2）必须按实参类型经试解消歧，
// 不能取 funcMap/funcs 里碰巧最后注册的那个签名。
describe('overloaded func/pred disambiguation by trial inference', () => {
  it('f(int,int)=int vs f(uint8,uint8)=uint8: int args pick int sig', async () => {
    await mk(
      ':- module ma.\n:- interface.\n:- func f(int, int) = int.\n:- end_module ma.\n',
      'ma',
    )
    await mk(
      ':- module mb.\n:- interface.\n:- type uint8.\n:- func f(uint8, uint8) = uint8.\n:- end_module mb.\n',
      'mb',
    )
    const docM = await mk(
      ':- module m.\n' +
      ':- interface.\n' +
      ':- implementation.\n' +
      ':- import_module ma.\n' +
      ':- import_module mb.\n' +
      'p(X, Y, Z) :- X = 1, Y = 2, Z = f(X, Y).\n' +
      ':- end_module m.\n',
      'm',
    )
    const inf = docM.visitResult!.inferred
    const fTerms = collectTerms(docM.parseResult.value, 'f/2').filter((t: any) => inf.get(t))
    expect(fTerms.length).toBeGreaterThan(0)
    for (const t of fTerms) {
      const i = inf.get(t) as any
      expect(i?.category).toBe('func')
      expect(merTypeToString(i.type)).toBe('int')
      // 选中的签名应是 int 版本（供 hover 显示）
      expect(i.sig?.argTypes.map(merTypeToString)).toEqual(['int', 'int'])
    }
    // Z 应推出 int
    const zTerms = collectTerms(docM.parseResult.value, 'Z/0').filter((t: any) => inf.get(t))
    expect(zTerms.length).toBeGreaterThan(0)
    for (const t of zTerms) expect(merTypeToString((inf.get(t) as any).type)).toBe('int')
  })

  it('ambiguous args (unknown types) keep func unlabeled by inference', async () => {
    await mk(
      ':- module ma2.\n:- interface.\n:- func f(int, int) = int.\n:- end_module ma2.\n',
      'ma2',
    )
    await mk(
      ':- module mb2.\n:- interface.\n:- type uint8.\n:- func f(uint8, uint8) = uint8.\n:- end_module mb2.\n',
      'mb2',
    )
    const docM = await mk(
      ':- module m2.\n' +
      ':- interface.\n' +
      ':- implementation.\n' +
      ':- import_module ma2.\n' +
      ':- import_module mb2.\n' +
      'p(X, Y, Z) :- Z = f(X, Y).\n' +
      ':- end_module m2.\n',
      'm2',
    )
    const inf = docM.visitResult!.inferred
    const fTerms = collectTerms(docM.parseResult.value, 'f/2').filter((t: any) => inf.get(t))
    for (const t of fTerms) {
      const i = inf.get(t) as any
      // 实参类型未知 → 不猜，category 不标 func
      expect(i?.category).not.toBe('func')
    }
  })
})
