import { beforeEach, describe, expect, it } from 'vitest'
import { URI } from 'vscode-uri'
import { Visitor } from '../document-visitor'
import { createMercuryServices, type MercuryServices } from '../services'
import { findDefTerms } from '../provide-definition'
import { ReferenceProvider } from '../provide-reference'
import { HoverProvider } from '../provide-hover'
import { termRange, type Term } from '../term'

let services: MercuryServices
beforeEach(() => { services = createMercuryServices() })

async function visit(src: string, name: string) {
  const uri = URI.parse(`file:///${name}.m`)
  const doc = services.documentFactory.fromString(src, uri)
  services.documents.addDocument(doc)
  await new Visitor(services).visit(doc, {
    isCancellationRequested: false,
    onCancellationRequested: () => undefined,
  } as any)
  return doc
}

// mercury/library/array.m 的字段访问函数写法：
//   :- func elem(int, array(T)) = T.
//   elem(Index, Array) = Elem :- array.lookup(Array, Index, Elem).
//   :- func 'elem :='(int, array(T), T) = array(T).
//   'elem :='(Index, !.Array, Value) = !:Array :- array.set(Index, Value, !Array).
const src = [
  ':- module m.',
  ':- interface.',
  ':- func elem(int, array(T)) = T.',
  ":- func 'elem :='(int, array(T), T) = array(T).",
  ':- end_module m.',
  ':- implementation.',
  'elem(Index, Array) = Elem :- array.lookup(Array, Index, Elem).',
  "'elem :='(Index, !.Array, Value) = !:Array :-",
  '    array.set(Index, Value, !Array).',
  'verify_sorted(A, Lo, Hi) :-',
  '    ( if Lo >= Hi then',
  '        true',
  '    else if compare((<), A ^ elem(Lo + 1), A ^ elem(Lo)) then',
  '        unexpected($pred, "array range not sorted")',
  '    else',
  '        verify_sorted(A, Lo + 1, Hi)',
  '    ).',
  'set_elem(A, I, V, B) :- B = A ^ elem(I) := V.',
].join('\n')

const locKey = (t: Term) => {
  const p = termRange(t).start
  return `${p.line}:${p.character}`
}

describe('record syntax ^ field specifier → field access function indexing', () => {
  it('indexes ^ elem(N) as a reference to elem/(N+1) and elem :=/(N+2)', async () => {
    const doc = await visit(src, 'field-access')
    const specs = [...doc.visitResult!.reference.get('elem')].filter(t => t.fieldAccess)
    expect(specs).toHaveLength(3) // 两处 selection，一处 `^ ... := V` update
    for (const t of specs) {
      // 语义实体是 field access function（函数），不是构造子字段标签 fieldname
      expect(t.semanticType).toBe('func')
      expect(t.semanticArity).toBe(2) // field specifier elem/1 → selection function elem/2
      expect(t.fieldAccess).toMatchObject({
        base: 'elem',
        specArity: 1,
        selectionName: 'elem',
        selectionArity: 2,
        updateName: 'elem :=',
        updateArity: 3,
      })
    }
    expect(specs.filter(t => t.fieldAccess!.role === 'select')).toHaveLength(2)
    expect(specs.filter(t => t.fieldAccess!.role === 'update')).toHaveLength(1)
    // 字段说明符的参数仍按普通数据项索引（Lo + 1 等不能丢）
    expect(doc.visitResult!.reference.get('+').length).toBeGreaterThan(0)
  })

  it('goto-definition on ^ elem finds both selection and update function decls/defs', async () => {
    const doc = await visit(src, 'field-access')
    const spec = [...doc.visitResult!.reference.get('elem')].find(t => t.fieldAccess)!
    const defs = findDefTerms(services, { term: spec, uri: doc.uri }).toArray()
    const keys = defs.map(d => `${d.term.name}/${d.term.semanticArity ?? d.term.arity}`)
    expect(keys).toContain('elem/2')       // :- func elem(...) 与 elem(...) = ...
    expect(keys).toContain('elem :=/3')   // :- func 'elem :='(...) 与其定义子句
    expect(keys.filter(k => k === 'elem/2')).toHaveLength(2)
    expect(keys.filter(k => k === 'elem :=/3')).toHaveLength(2)
  })

  it('find-references on the elem := definition reaches the ^ elem occurrences', async () => {
    const doc = await visit(src, 'field-access')
    const updDef = doc.visitResult!.definition.get('elem :=')[0]
    const refs: any = await ReferenceProvider(services, {
      textDocument: { uri: doc.uri.toString() },
      position: termRange(updDef).start,
    } as any)
    const specs = [...doc.visitResult!.reference.get('elem')].filter(t => t.fieldAccess)
    const keys = refs.map((r: any) => `${r.range.start.line}:${r.range.start.character}`)
    for (const spec of specs) expect(keys).toContain(locKey(spec))
  })

  it('hover on ^ elem shows the field selection function signature', async () => {
    const doc = await visit(src, 'field-access')
    const spec = [...doc.visitResult!.reference.get('elem')].find(t => t.fieldAccess)!
    const hover: any = await HoverProvider(services, {
      textDocument: { uri: doc.uri.toString() },
      position: termRange(spec).start,
    } as any)
    expect(hover?.contents?.value).toContain('(func) elem/2')
    expect(hover?.contents?.value).toContain('type elem(')
  })

  it('also links to the field label `elem :: T` that generates the access functions', async () => {
    const doc = await visit([
      ':- module m.',
      ':- interface.',
      ':- type r ---> r(elem :: int).',
      ':- end_module m.',
      ':- implementation.',
      'get(R, X) :- X = R ^ elem.',
    ].join('\n'), 'field-label')
    const spec = [...doc.visitResult!.reference.get('elem')].find(t => t.fieldAccess)!
    expect(spec.semanticArity).toBe(1) // elem/0 → selection function elem/1
    const label = doc.visitResult!.definition.get('elem').find(t => t.semanticType === 'fieldname')
    expect(label).toBeDefined()
    const defs = findDefTerms(services, { term: spec, uri: doc.uri }).toArray()
    expect(defs.map(d => d.term.semanticType)).toContain('fieldname')
    const refs: any = await ReferenceProvider(services, {
      textDocument: { uri: doc.uri.toString() },
      position: termRange(label!).start,
    } as any)
    const keys = refs.map((r: any) => `${r.range.start.line}:${r.range.start.character}`)
    expect(keys).toContain(locKey(spec))
  })
})
