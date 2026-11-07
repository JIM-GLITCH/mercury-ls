import { beforeEach, describe, expect, it } from 'vitest'
import { URI } from 'vscode-uri'
import { createMercuryServices, type MercuryServices } from '../services'
import { merTypeToString } from '../document-type'

let services: MercuryServices
beforeEach(() => { services = createMercuryServices() })

const token = {
  isCancellationRequested: false,
  onCancellationRequested: () => undefined,
} as any

function add(src: string, name: string) {
  const uri = URI.parse(`file:///${name}.m`)
  const doc = services.documentFactory.fromString(src, uri)
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
  const info = doc.visitResult!.inferred.get(t)
  return info ? merTypeToString(info.type) : undefined
}

const source = (expr: string) => [
  ':- module m.',
  ':- interface.',
  ':- end_module m.',
  ':- implementation.',
  ':- pred f(int).',
  `f(X) :- X = ${expr}.`,
].join('\n')

describe('type inference derives the type of +/2 directly', () => {
  it('derives int for 1+1 even with no +/2 declaration anywhere', async () => {
    const m = add(source('1+1'), 'm')
    await services.builder.build([m], token)

    const plus = collect(m.parseResult.value, (t: any) => t.nameArity === '+/2')[0]
    expect(plus).toBeDefined()
    expect(typeOf(m, plus)).toBe('int')
    expect(m.visitResult!.inferred.get(plus)!.category).toBe('func')
    const x = collect(m.parseResult.value, (t: any) => t.syntaxType === 'variable' && t.name === 'X')[0]
    expect(typeOf(m, x)).toBe('int')
  })

  it('ignores an unrelated float overload instead of copying it into inferred', async () => {
    const floats = add([
      ':- module floats.',
      ':- interface.',
      ':- func (float::in) + (float::in) = (float::uo) is det.',
      ':- end_module floats.',
    ].join('\n'), 'floats')
    const m = add(source('1+1'), 'm')
    await services.builder.build([floats, m], token)

    const plus = collect(m.parseResult.value, (t: any) => t.nameArity === '+/2')[0]
    expect(typeOf(m, plus)).toBe('int')
    expect(typeOf(m, plus)).not.toBe('float')
  })

  it('derives float from float literal arguments', async () => {
    const m = add(source('1.0 + 2.0'), 'm')
    await services.builder.build([m], token)

    const plus = collect(m.parseResult.value, (t: any) => t.nameArity === '+/2')[0]
    expect(typeOf(m, plus)).toBe('float')
  })
})
