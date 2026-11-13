import { beforeEach, describe, it, expect } from 'vitest'
import { URI } from 'vscode-uri'
import { Visitor } from '../document-visitor'
import { createMercuryServices, type MercuryServices } from '../services'
import { merTypeToString } from '../document-type'

let services: MercuryServices
beforeEach(() => {
  services = createMercuryServices()
})

const token = {
  isCancellationRequested: false,
  onCancellationRequested: () => undefined,
} as any

function collectVars(root: any, name: string): any[] {
  const out: any[] = []
  const walk = (t: any) => {
    if (t && typeof t === 'object' && 'nameArity' in t) {
      if (t.name === name) out.push(t)
      if (Array.isArray(t.args)) t.args.forEach(walk)
    }
  }
  walk(root)
  return out
}

// 回归：文档重建时 invalidateDocument 会清空 visitResult，但 ModuleManager 里的
// 旧登记仍在。重访期间 moduleManager.get() 若对 visitResult 为空的候选取
// .module 会抛异常，被 inferClause 的 catch 静默吞掉 → 整个子句推断中断
// （真实场景：array.m 里 array.size(...) 自限定调用，重建后 SizeA 变 unknown、
// `+` 重载消歧失败、hover 回退到 funcMap 里最后注册的 uint8 签名）。
describe('module manager survives document re-visit', () => {
  it('qualified self-calls still infer after invalidate + re-visit', async () => {
    const uri = URI.parse('file:///arr.m')
    const doc = services.documentFactory.fromString(
      ':- module arr.\n' +
      ':- interface.\n' +
      ':- func size(list(T)) = int.\n' +
      ':- implementation.\n' +
      'p(L, S) :- S = arr.size(L).\n' +
      ':- end_module arr.\n',
      uri,
    )
    services.documents.addDocument(doc)

    const visitAndRegister = async () => {
      await new Visitor(services).visit(doc, token)
      const mod = doc.visitResult!.module
      if (mod) services.moduleManager.set(mod, doc)
      services.exportManager.set(doc)
    }

    await visitAndRegister()
    const sType1 = collectVars(doc.parseResult.value, 'S')
      .map(t => doc.visitResult!.inferred.get(t))
      .filter(Boolean)
      .map(i => merTypeToString(i!.type))
    expect(sType1.length).toBeGreaterThan(0)
    for (const t of sType1) expect(t).toBe('int')

    // 模拟编辑：builder.invalidateDocument 的效果 + 重建
    doc.visitResult = undefined
    doc.state = 0 as any
    await visitAndRegister()

    const sType2 = collectVars(doc.parseResult.value, 'S')
      .map(t => doc.visitResult!.inferred.get(t))
      .filter(Boolean)
      .map(i => merTypeToString(i!.type))
    expect(sType2.length).toBeGreaterThan(0)
    for (const t of sType2) expect(t).toBe('int')
  })
})
