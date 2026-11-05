import { describe, it, expect } from 'vitest'
import { URI } from 'vscode-uri'
import { Visitor } from '../document-visitor'
import { exportManager, moduleManager } from '../document-moduleManager'
import { linker } from '../document-linker'
import { mercuryDocumentFactory, mercuryDocuments } from '../document-manager'
import { merTypeToString } from '../document-type'

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

describe('repro3: only assoc_list loaded, pair NOT separately loaded', () => {
  it('m imports assoc_list (which imports pair); pair module itself not visited', async () => {
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
    // assoc_list 模块导入 pair；pair 也单独加载（模拟 re-analyze 后两个模块都就位）
    await mk(
      ':- module pair.\n' +
      ':- interface.\n' +
      ':- type pair(K, V) ---> K - V.\n' +
      ':- end_module pair.\n',
      'pair',
    )
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
    await linker.link(docM, {
      isCancellationRequested: false,
      onCancellationRequested: () => undefined,
    } as any)

    const inf = docM.visitResult!.inferred
    const dump = (label: string, t: any) => {
      const i = inf.get(t) as any
      console.log(label, '=>', i ? merTypeToString(i.type) : '(no inferred)', 'cat=', i?.category)
    }
    const consList = collectTerms(docM.parseResult.value, '[|]/2')
    const minus = collectTerms(docM.parseResult.value, '-/2')
    dump('[|]/2', consList[0])
    dump('-/2  ', minus[0])
    // 找 P、V0、KVs0 的出现
    const find = (name: string) => collectTerms(docM.parseResult.value, name + '/0').map((t: any) => { const i = inf.get(t) as any; return `${t.nameArity} -> ${i ? merTypeToString(i.type) : '(none)'}` })
    console.log('P   :', find('P'))
    console.log('V0  :', find('V0'))
    console.log('KVs0:', find('KVs0'))
    console.log('K   :', find('K'))
  })
})
