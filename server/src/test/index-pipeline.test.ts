import { beforeEach, describe, it, expect } from 'vitest'
import { URI } from 'vscode-uri'
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

function add(src: string, name: string) {
  const uri = URI.parse(`file:///${name}.m`)
  const doc = services.documentFactory.fromString(src, uri)
  services.documents.addDocument(doc)
  return doc
}

function inferredTypesOf(doc: any, name: string): string[] {
  const out: string[] = []
  for (const [t, info] of doc.visitResult!.inferred.entries()) {
    if (t.name === name) out.push(merTypeToString(info.type))
  }
  return out
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

    await services.builder.build([doc], token)

    const mi = services.index.get(doc)!
    // 索引阶段直接产出全局表条目，不再有 VisitResult → ModuleIndex 的转换对象
    expect(mi).toBe(doc.visitResult)
    expect(mi.moduleName).toBe('demo')

    // 2a：pred/func/type/ctor/inst/mode 的结构化定义
    const kinds = (name: string) => mi.symbols.filter(s => s.name === name).map(s => s.kind)
    expect(kinds('p')).toContain('pred')
    expect(kinds('f')).toContain('func')
    expect(kinds('tree')).toContain('type')
    expect(kinds('node')).toContain('constructor')
    expect(kinds('i_eq')).toContain('inst')
    expect(kinds('m_eq')).toContain('mode')
    expect(mi.funcs.has('f/1')).toBe(true)
    expect(mi.preds.has('p/2')).toBe(true)
    expect(mi.types.has('tree/1')).toBe(true)
    expect(mi.instDefs.size).toBeGreaterThan(0)
    expect(mi.modeDefs.size).toBeGreaterThan(0)

    // 2b：import_module 与 use_module 分开记录
    expect(mi.moduleImports).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'import_module', module: 'io', section: 'interface' }),
      expect.objectContaining({ kind: 'import_module', module: 'list', section: 'interface' }),
      expect.objectContaining({ kind: 'use_module', module: 'int', section: 'interface' }),
    ]))
    expect(Array.from(services.index.visibleModules(doc))).toEqual(
      expect.arrayContaining(['demo', 'io', 'list', 'int']),
    )

    // 2c：只有 interface 段的符号被标记导出；implementation 段的声明不导出
    for (const name of ['p', 'f', 'tree', 'node', 'i_eq', 'm_eq']) {
      expect(mi.symbols.some(s => s.name === name && s.exported)).toBe(true)
    }
    for (const name of ['hidden', 'h1', 'q']) {
      expect(mi.symbols.filter(s => s.name === name).every(s => !s.exported)).toBe(true)
    }
    expect(services.index.getByName('q')).toEqual([])
    expect(services.index.getByName('p').every(s => s.module === 'demo')).toBe(true)
  })

  it('阶段 3：声明写在 clause 之后也能拿到签名（不再随 visit 顺序推导）', async () => {
    const doc = add([
      ':- module late.',
      ':- implementation.',
      'p(X) :- true.',
      ':- pred p(pair(int, string)::out) is det.',
    ].join('\n'), 'late')

    await services.builder.build([doc], token)

    // body 是 true，X 的类型只能来自 head 签名；旧流程此时签名还没收集到
    expect(inferredTypesOf(doc, 'X')).toContain('pair(int, string)')
  })

  it('阶段 3：跨模块签名与可见性在推导前就绪（importer 排在 import 目标之前 + use_module）', async () => {
    // 故意把 importer 放在前面：旧流程的 import_module 拓扑排序不认 use_module
    const app = add([
      ':- module app.',
      ':- interface.',
      ':- end_module app.',
      ':- implementation.',
      ':- use_module lib.',
      'main(X) :- helper(X), X = twice(1).',
    ].join('\n'), 'app')
    const lib = add([
      ':- module lib.',
      ':- interface.',
      ':- pred helper(int::in) is det.',
      ':- func twice(int) = int.',
      ':- end_module lib.',
      ':- implementation.',
      'helper(_).',
      'twice(X) = X.',
    ].join('\n'), 'lib')

    await services.builder.build([app, lib], token)

    expect(services.index.get(app)).toBeDefined()
    expect(services.index.get(lib)).toBeDefined()
    // helper 的签名来自全局符号表（导出 + 可见），X 由此被合成为 int
    expect(inferredTypesOf(app, 'X')).toContain('int')

    // qualified 解析：body 里的非限定引用解析到全局符号表中已导出的目标模块
    const helper = collectTerms(app.parseResult.value, 'helper/1')[0]
    const entries = app.visitResult!.resolved.get(helper)
    expect(entries?.length).toBeGreaterThan(0)
    expect(entries?.[0].module).toBe('lib')
    expect(entries?.[0].exported).toBe(true)
    const helperEntries = services.index.getByName('helper')
    expect(helperEntries.length).toBeGreaterThan(0)
    expect(helperEntries.every(s => s.module === 'lib' && s.exported)).toBe(true)
  })
})
