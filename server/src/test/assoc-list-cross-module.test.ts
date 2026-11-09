import { beforeEach, describe, it, expect } from 'vitest'
import { URI } from 'vscode-uri'

import { createMercuryServices, type MercuryServices } from '../services'

let services: MercuryServices
beforeEach(() => {
  services = createMercuryServices()
})

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

function merTypeToString(t: any): string {
  if (t.kind === 'var') return t.name
  if (t.kind === 'ctor') return `${t.ctor.name}(${t.args.map(merTypeToString).join(', ')})`
  return '?'
}

describe('cross-module assoc_list with split pair module + recursive call', () => {
  it('infers [|]/2, -/2 as constructors and K typed when assoc_list/pair are separate imported modules', async () => {
    const mk = async (src: string, name: string) => {
      const uri = URI.parse(`file:///${name}.m`)
      const doc = services.documentFactory.fromString(src, uri)
      services.documents.addDocument(doc)
      await services.index.index(doc, {
        isCancellationRequested: false,
        onCancellationRequested: () => undefined,
      } as any)
      const mod = services.index.get(doc)!.module
      return doc
    }
    // pair 在独立模块
    await mk(
      ':- module pair.\n' +
      ':- interface.\n' +
      ':- type pair(K, V) ---> K - V.\n' +
      ':- end_module pair.\n',
      'pair',
    )
    // assoc_list 在独立模块，import pair
    await mk(
      ':- module assoc_list.\n' +
      ':- interface.\n' +
      ':- import_module pair.\n' +
      ':- type assoc_list(K, V) == list(pair(K, V)).\n' +
      ':- end_module assoc_list.\n',
      'assoc_list',
    )
    const docM = await mk(
      ':- module m.\n' +
      ':- interface.\n' +
      ':- pred map_values_only(pred(V, W)::in(pred(in, out), det), assoc_list(K, V)::in, assoc_list(K, W)::out) is det.\n' +
      ':- end_module m.\n' +
      ':- implementation.\n' +
      ':- import_module assoc_list.\n' +
      'map_values_only(_P, [], []).\n' +
      'map_values_only(P, [K - V0 | KVs0], [K - V | KVs]) :-\n' +
      '    P(V0, V),\n' +
      '    map_values_only(P, KVs0, KVs).\n',
      'm',
    )
    await services.linker.link(docM, {
      isCancellationRequested: false,
      onCancellationRequested: () => undefined,
    } as any)

    const consList = collectTerms(docM.parseResult.value, '[|]/2')
    const minus = collectTerms(docM.parseResult.value, '-/2')
    expect(consList.length).toBeGreaterThan(0)
    for (const t of consList) expect((services.index.get(docM)!.inferred.get(t) as any)?.category).toBe('constructor')
    expect(minus.length).toBeGreaterThan(0)
    for (const t of minus) expect((services.index.get(docM)!.inferred.get(t) as any)?.category).toBe('constructor')
    const kInfo = [...services.index.get(docM)!.inferred.entries()].filter(([t]: any) => t.name === 'K')
    expect(kInfo.length).toBeGreaterThan(0)
    for (const [, info] of kInfo) expect(merTypeToString((info as any).type)).toBe('K')
  })
})
