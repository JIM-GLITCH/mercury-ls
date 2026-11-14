import { beforeEach, describe, it, expect } from 'vitest'
import { URI } from 'vscode-uri'
import { Visitor } from '../document-visitor'
import { createMercuryServices, type MercuryServices } from '../services'
import { merTypeToString, unify, type MerType } from '../document-type'

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

const ctor = (name: string, module?: string): MerType =>
  ({ kind: 'ctor', ctor: { name, arity: 0, module }, args: [] })

// TypeCtor 携带 module/限定名：qualified 引用直接记限定符，未限定引用按
// 「本模块 → 全局导出索引唯一命中」解析；unify 时两侧模块不同即不匹配
describe('module-qualified type constructors', () => {
  it('records module on qualified type refs; hover renders io.error', async () => {
    await mk(':- module io.\n:- interface.\n:- type error.\n:- end_module io.\n', 'io')
    const doc = await mk(
      ':- module m.\n:- interface.\n:- pred p(io.error).\n:- end_module m.\n', 'm')
    const p = doc.visitResult!.preds.get('p/1')!
    expect(merTypeToString(p.argTypes[0])).toBe('io.error')
  })

  it('declared types carry their module; unqualified refs resolve to it', async () => {
    await mk(':- module msi.\n:- interface.\n:- type stream_info.\n:- end_module msi.\n', 'msi')
    const doc = await mk(
      ':- module m.\n:- interface.\n:- import_module msi.\n:- pred p(stream_info).\n:- end_module m.\n', 'm2')
    const p = doc.visitResult!.preds.get('p/1')!
    expect(merTypeToString(p.argTypes[0])).toBe('msi.stream_info')
  })

  it('same-name types in different modules do not unify; missing module is wildcard', () => {
    const ioErr = ctor('error', 'io')
    const otherErr = ctor('error', 'other')
    const bareErr = ctor('error')
    expect(unify(ioErr, otherErr, new Map())).toBe(false)
    expect(unify(ioErr, bareErr, new Map())).toBe(true)
    expect(unify(bareErr, otherErr, new Map())).toBe(true)
    expect(merTypeToString(ioErr)).toBe('io.error')
    expect(merTypeToString(bareErr)).toBe('error')
  })

  it('ambiguous unqualified ref stays unresolved (renders bare name)', async () => {
    await mk(':- module ea.\n:- interface.\n:- type dup.\n:- end_module ea.\n', 'ea')
    await mk(':- module eb.\n:- interface.\n:- type dup.\n:- end_module eb.\n', 'eb')
    const doc = await mk(
      ':- module m.\n:- interface.\n:- pred p(dup).\n:- end_module m.\n', 'm3')
    const p = doc.visitResult!.preds.get('p/1')!
    // ea.dup 与 eb.dup 并存 → 不猜模块，显示裸名（unify 仍按通配兼容）
    expect(merTypeToString(p.argTypes[0])).toBe('dup')
  })
})
