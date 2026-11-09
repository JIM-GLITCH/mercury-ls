import { beforeEach, describe, expect, it } from 'vitest'
import { URI } from 'vscode-uri'
import { createMercuryServices, type MercuryServices } from '../services'
import { merTypeToString } from '../document-type'
import { termTokenRange } from '../utils'

let services: MercuryServices
beforeEach(() => { services = createMercuryServices() })

const token = {
  isCancellationRequested: false,
  onCancellationRequested: () => undefined,
} as any

function collect(root: any, pred: (t: any) => boolean, acc: any[] = []): any[] {
  if (!root) return acc
  if (pred(root)) acc.push(root)
  for (const a of root.args ?? []) collect(a, pred, acc)
  return acc
}

describe('nullary operator constructors', () => {
  it('keeps (=), (<), (>) as comparison_result constructors even with a >/2 declaration', async () => {
    const src = [
      ':- module rat.',
      ':- interface.',
      ':- type comparison_result ---> (=) ; (<) ; (>).',
      ':- type rational ---> r(int, int).',
      ':- pred >(rational, rational).',
      ':- func cmp(rational, rational) = comparison_result.',
      ':- end_module rat.',
      ':- implementation.',
      'cmp(R1, R2) = Cmp :-',
      '    Diff = R1 - R2,',
      '    ( if is_zero(Diff) then',
      '        Cmp = (=)',
      '    else if is_negative(Diff) then',
      '        Cmp = (<)',
      '    else',
      '        Cmp = (>) ).',
    ].join('\n')
    const doc = services.documentFactory.fromString(src, URI.parse('file:///rat.m'))
    services.documents.addDocument(doc)
    await services.builder.build([doc], token)

    const ref = (name: string) => collect(
      doc.parseResult.value,
      (t: any) => t.name === name && t.arity === 0 && services.index.get(doc)!.inferred.has(t),
    )[0]

    for (const name of ['=', '<', '>']) {
      const t = ref(name)
      expect(t, `${name}/0`).toBeDefined()
      expect(t.semanticType).toBe('constructor')
      expect(t.semanticArity).toBe(0)
      expect(merTypeToString(services.index.get(doc)!.inferred.get(t)!.type)).toBe('comparison_result')
      expect(services.index.get(doc)!.inferred.get(t)!.category).toBe('constructor')
    }

    const gt = ref('>')
    const hover: any = await services.providers.hover({
      textDocument: { uri: doc.uri.toString() },
      position: termTokenRange(gt).start,
    } as any)
    expect(hover?.contents?.value).not.toContain('(pred)')
    expect(hover?.contents?.value).not.toContain('rational')
    expect(hover?.contents?.value).toContain('comparison_result')
  })
})
