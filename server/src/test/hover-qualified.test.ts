import { beforeEach, describe, expect, it } from 'vitest'
import { URI } from 'vscode-uri'
import { createMercuryServices, type MercuryServices } from '../services'
import { termTokenRange } from '../utils'

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

async function hoverValue(doc: any, term: any): Promise<string> {
  const hover: any = await services.providers.hover({
    textDocument: { uri: doc.uri.toString() },
    position: termTokenRange(term).start,
  })
  return hover?.contents?.value ?? ''
}

const libSrc = [
  ':- module lib.',
  ':- interface.',
  ':- pred helper(int::in) is det.',
  ':- end_module lib.',
  ':- implementation.',
  'helper(_).',
].join('\n')

describe('hover shows qualified names', () => {
  it('uses the owning module for a declaration in the current file', async () => {
    const doc = add([
      ':- module m.',
      ':- interface.',
      ':- pred p(int).',
      ':- end_module m.',
      ':- implementation.',
      'p(1).',
    ].join('\n'), 'local')
    await services.builder.build([doc], token)

    const p = collect(doc.parseResult.value, (t: any) => t.nameArity === 'p/1' && t.semanticType === 'pred')[0]
    expect(p).toBeDefined()
    expect(await hoverValue(doc, p)).toContain('(pred) m.p/1')
  })

  it('uses the resolved target module for an unqualified cross-module reference', async () => {
    const lib = add(libSrc, 'lib')
    const app = add([
      ':- module app.',
      ':- interface.',
      ':- end_module app.',
      ':- implementation.',
      ':- use_module lib.',
      'main(X) :- helper(X).',
    ].join('\n'), 'app')
    await services.builder.build([app, lib], token)

    const helper = collect(app.parseResult.value, (t: any) => t.nameArity === 'helper/1')[0]
    expect(helper).toBeDefined()
    expect(await hoverValue(app, helper)).toContain('(pred) lib.helper/1')
  })

  it('uses the explicit qualifier for a qualified reference', async () => {
    const lib = add(libSrc, 'lib')
    const app = add([
      ':- module app.',
      ':- interface.',
      ':- end_module app.',
      ':- implementation.',
      ':- use_module lib.',
      'main(X) :- lib.helper(X).',
    ].join('\n'), 'app')
    await services.builder.build([app, lib], token)

    const helper = collect(app.parseResult.value, (t: any) => t.nameArity === 'helper/1')[0]
    expect(helper).toBeDefined()
    expect(await hoverValue(app, helper)).toContain('(pred) lib.helper/1')
  })

  it('falls back to the bare name when no module is known', async () => {
    const doc = add([
      ':- pred g(int).',
      'g(1).',
    ].join('\n'), 'nomod')
    await services.builder.build([doc], token)

    const g = collect(doc.parseResult.value, (t: any) => t.nameArity === 'g/1' && t.semanticType === 'pred')[0]
    expect(g).toBeDefined()
    const value = await hoverValue(doc, g)
    expect(value).toContain('(pred) g/1')
    expect(value).not.toContain('.g/1')
  })
})
