import { beforeEach, describe, it, expect } from 'vitest'
import { URI } from 'vscode-uri'
import { createMercuryServices, type MercuryServices } from '../services'
import { CancellationToken } from 'vscode-languageserver'
import { constructorType, MerType, typeType, varType } from '../document-type'
import { TypeInferer } from '../document-typeinfer'

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
      ':- pred demo.qq(int::out) is det.',
    ].join('\n'), 'demo')

    await services.index.update(doc, CancellationToken.None)
    //  确定每个元素存在
    expect(services.index.get("demo").length).toBeGreaterThan(0)
    expect(services.index.get("io").length).toBeGreaterThan(0)
    expect(services.index.get("list").length).toBeGreaterThan(0)
    expect(services.index.get("int").length).toBeGreaterThan(0)
    expect(services.index.get("p").length).toBeGreaterThan(0)
    expect(services.index.get("f").length).toBeGreaterThan(0)
    expect(services.index.get("tree").length).toBeGreaterThan(0)
    expect(services.index.get("leaf").length).toBeGreaterThan(0)
    expect(services.index.get("node").length).toBeGreaterThan(0)
    expect(services.index.get("m_eq").length).toBeGreaterThan(0)
    expect(services.index.get("hidden").length).toBeGreaterThan(0)
    expect(services.index.get("h1").length).toBeGreaterThan(0)
    expect(services.index.get("q").length).toBeGreaterThan(0)

    // 确定每个元素的kind
    expect(services.index.get("demo")[0].kind).toBe("module")
    expect(services.index.get("io")[0].kind).toBe("module")
    expect(services.index.get("list")[0].kind).toBe("module")
    expect(services.index.get("int")[0].kind).toBe("module")
    expect(services.index.get("p")[0].kind).toBe("pred")
    expect(services.index.get("f")[0].kind).toBe("func")
    expect(services.index.get("tree")[0].kind).toBe("type")
    expect(services.index.get("leaf")[0].kind).toBe("constructor")
    expect(services.index.get("node")[0].kind).toBe("constructor")
    expect(services.index.get("m_eq")[0].kind).toBe("mode")
    expect(services.index.get("hidden")[0].kind).toBe("type")
    expect(services.index.get("h1")[0].kind).toBe("constructor")

    //  确定函数和谓词的签名
    expect(services.index.get("p")[0].signature).toMatchObject({ "kind": "pred", "name": "p", "args": [{ "kind": "type", "name": "int" }, { "kind": "type", "name": "int" }]} as MerType)
    expect(services.index.get("f")[0].signature).toMatchObject({ "kind": "func", "name": "f", "args": [{ "kind": "type", "name": "int" }],result:{"kind": "type", "name": "int"}} as MerType)
    expect(services.index.get("q")[0].signature).toMatchObject({ "kind": "pred", "name": "q", "args": [{ "kind": "type", "name": "int" }]} as MerType)

    //  确定 类型 和 constructor的签名
    const T_signature = varType("T")
    const tree_signature = typeType("tree",[T_signature])
    const leaf_signature = constructorType("leaf",[],tree_signature)
    const node_signature = constructorType("node",[T_signature,tree_signature],tree_signature)
    expect(services.index.get("tree")[0].signature).toMatchObject(tree_signature)
    expect(services.index.get("leaf")[0].signature).toMatchObject(leaf_signature )
    expect(services.index.get("node")[0].signature).toMatchObject(node_signature)

    // 确定支持 quliafied
    expect(services.index.get("qq")[0].module).toBe("demo")
    expect(services.index.get("qq")[0].signature).toMatchObject({ "kind": "pred", "name": "qq", "args": [{ "kind": "type", "name": "int" }]} as MerType)

  })
})
