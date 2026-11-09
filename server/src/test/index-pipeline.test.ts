import { beforeEach, describe, it, expect } from 'vitest'
import { URI } from 'vscode-uri'
import { createMercuryServices, type MercuryServices } from '../services'
import { CancellationToken } from 'vscode-languageserver'

let services: MercuryServices
beforeEach(() => {
  services = createMercuryServices()
})

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


function collectTerms(root: any, nameArity: string, acc: any[] = []): any[] {
  if (!root) return acc
  if (root.nameArity === nameArity) acc.push(root)
  for (const a of root.args ?? []) collectTerms(a, nameArity, acc)
  return acc
}

describe('parse → 全局 index → clause body 推导/qualified', () => {
  it('阶段 2a/2b/2c：定义、import/use、interface 导出标记都进全局符号表', async () => {
    const doc = add([
      ':- module demo.',
      ':- interface.',
      ':- import_module io, list.',
      ':- use_module int.',
      ':- pred p(int::in, int::out) is det.',
      ':- func f(int) = int.',
      ':- type tree(T) ---> leaf ; node(T, tree(T)).',
      ':- inst i_eq == ground.',
      ':- mode m_eq == in >> out.',
      ':- end_module demo.',
      ':- implementation.',
      ':- type hidden ---> h1.',
      ':- pred q(int::out) is det.',
      'q(1).',
    ].join('\n'), 'demo')

    await services.index.update(doc, CancellationToken.None)
    expect(services.index.get("demo").length).greaterThan(0)
    expect(services.index.get("io").length).greaterThan(0)
    expect(services.index.get("list").length).greaterThan(0)
    expect(services.index.get("int").length).greaterThan(0)
    expect(services.index.get("p").length).greaterThan(0)
    expect(services.index.get("f").length).greaterThan(0)
    expect(services.index.get("tree").length).greaterThan(0)
    expect(services.index.get("leaf").length).greaterThan(0)
    expect(services.index.get("node").length).greaterThan(0)
    expect(services.index.get("inst").length).greaterThan(0)
    expect(services.index.get("m_eq").length).greaterThan(0)
    expect(services.index.get("hidden").length).greaterThan(0)
    expect(services.index.get("h1").length).greaterThan(0)
    expect(services.index.get("q").length).greaterThan(0)





  })
})
