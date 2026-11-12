import { beforeEach, describe, expect, it } from 'vitest'
import { URI } from 'vscode-uri'
import { Visitor } from '../document-visitor'
import { createMercuryServices, type MercuryServices } from '../services'

let services: MercuryServices
beforeEach(() => { services = createMercuryServices() })

async function mk(src: string, name: string, index = true) {
  const uri = URI.parse(`file:///${name}.m`)
  const doc = services.documentFactory.fromString(src, uri)
  services.documents.addDocument(doc)
  await new Visitor(services).visit(doc, {
    isCancellationRequested: false,
    onCancellationRequested: () => undefined,
  } as any)
  const mod = doc.visitResult!.module
  if (mod && index) services.moduleManager.set(mod, doc)
  if (index) services.exportManager.set(doc)
  return doc
}

async function complete(src: string, name: string, line: number) {
  const doc = await mk(src, name, false)
  const position = { line, character: src.split('\n')[line].length }
  const items: any = await services.providers.completion({
    textDocument: { uri: doc.uri.toString() },
    position,
    context: { triggerKind: 2, triggerCharacter: '.' },
  } as any)
  return { doc, position, items }
}

const arrayModule = [
  ':- module array.',
  ':- interface.',
  ':- type array(T).',
  ':- pred lookup(int, array(T), T).',
  ':- mode lookup(in, in, out) is det.',
  ':- func size(array(T)) = int.',
  ':- end_module array.',
].join('\n')

const clientHead = [
  ':- module client.',
  ':- interface.',
  ':- end_module client.',
  ':- implementation.',
].join('\n')

describe('completion after `.` uses the token before it as a module name', () => {
  it('lists the module interface exports when typing `array.`', async () => {
    await mk(arrayModule, 'array')
    const { items } = await complete(`${clientHead}\np(A, X) :- array.`, 'client', 4)
    const labels = items.map((i: any) => i.label)
    expect(labels).toContain('lookup')
    expect(labels).toContain('size')
    expect(labels).toContain('array')
    expect(items.find((i: any) => i.label === 'lookup').kind).toBe(3)  // Function
    expect(items.find((i: any) => i.label === 'size').detail).toContain('type size(')
    // 只替换 `.` 之后的部分，不吞掉 `.`
    const edit = items.find((i: any) => i.label === 'lookup').textEdit
    expect(edit.range.start).toEqual({ line: 4, character: 'p(A, X) :- array.'.length })
    expect(edit.newText).toBe('lookup')
  })

  it('filters by the fragment already typed after the dot', async () => {
    await mk(arrayModule, 'array')
    const { items } = await complete(`${clientHead}\np(A, X) :- array.lo`, 'client', 4)
    expect(items.map((i: any) => i.label)).toEqual(['lookup'])
  })

  it('returns nothing when the token before `.` is not a known module', async () => {
    await mk(arrayModule, 'array')
    const { items } = await complete(`${clientHead}\np(A, X) :- A.`, 'client', 4)
    expect(items).toEqual([])
  })

  it('ignores terminating dots in declarations and dots inside strings', async () => {
    await mk(arrayModule, 'array')
    const decl = await complete(`${clientHead}\n:- import_module array.`, 'client_decl', 4)
    expect(decl.items).toEqual([])
    const str = await complete(`${clientHead}\np(S) :- S = "array.`, 'client_str', 4)
    expect(str.items).toEqual([])
  })

  it('falls back to the current document exports when it is not in the global index', async () => {
    const src = [
      ':- module self.',
      ':- interface.',
      ':- pred foo(int).',
      ':- end_module self.',
      ':- implementation.',
      'p(X) :- self.',
    ].join('\n')
    const { items } = await complete(src, 'self', 5)
    expect(items.map((i: any) => i.label)).toContain('foo')
  })

  it('supports dotted module names and suggests submodules', async () => {
    await mk([
      ':- module std.array.',
      ':- interface.',
      ':- func make(int) = int.',
      ':- end_module std.array.',
    ].join('\n'), 'std_array')
    const { items } = await complete(`${clientHead}\np(X) :- std.array.`, 'client', 4)
    expect(items.map((i: any) => i.label)).toContain('make')
    const std = await complete(`${clientHead}\np(X) :- std.`, 'client_parent', 4)
    expect(std.items.map((i: any) => i.label)).toContain('array')
    expect(std.items.find((i: any) => i.label === 'array').kind).toBe(9) // Module
  })

  it('resolve adds the signature documentation', async () => {
    await mk(arrayModule, 'array')
    const { items } = await complete(`${clientHead}\np(A, X) :- array.`, 'client', 4)
    const item = items.find((i: any) => i.label === 'size')
    const resolved: any = services.providers.completionResolve(item)
    expect(resolved.documentation?.value).toContain('type size(')
    expect(resolved.documentation?.value).toContain('module array')
  })
})
