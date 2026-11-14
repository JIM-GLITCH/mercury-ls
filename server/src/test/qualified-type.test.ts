import { beforeEach, describe, it, expect } from 'vitest'
import { URI } from 'vscode-uri'
import { Visitor } from '../document-visitor'
import { createMercuryServices, type MercuryServices } from '../services'
import { merTypeToString, unify, type MerType } from '../document-type'
import { termRange, moduleQualifiedName } from '../term'
import { scanHeader } from '../document-order'

let services: MercuryServices
beforeEach(() => {
  services = createMercuryServices()
})

async function mk(src: string, name: string) {
  const uri = URI.parse(`file:///${name}.m`)
  const doc = services.documentFactory.fromString(src, uri)
  services.documents.addDocument(doc)
  await new Visitor(services).visit(doc, {
    isCancellationRequested: false,
    onCancellationRequested: () => undefined,
  } as any)
  const mod = doc.visitResult!.module
  if (mod) services.moduleManager.set(mod, doc)
  services.exportManager.set(doc)
  return doc
}

const ctor = (name: string, module?: string): MerType =>
  ({ kind: 'ctor', ctor: { name, arity: 0, module }, args: [] })

// TypeCtor 携带 module/限定名：qualified 引用直接记限定符，未限定引用按
// 「本模块 → 全局导出索引唯一命中」解析；unify 时两侧模块不同即不匹配
describe('module-qualified type constructors', () => {
  it('records module on qualified type refs; hover renders io.error', async () => {
    await mk(':- module io.\n:- interface.\n:- type error.\n:- end_module io.\n', 'io')
    const doc = await mk(
      ':- module m.\n:- interface.\n:- pred p(io.error).\n:- end_module m.\n', 'm')
    const p = doc.visitResult!.preds.get('p/1')!
    expect(merTypeToString(p.argTypes[0])).toBe('io.error')
  })

  it('declared types carry their module; unqualified refs resolve to it', async () => {
    await mk(':- module msi.\n:- interface.\n:- type stream_info.\n:- end_module msi.\n', 'msi')
    const doc = await mk(
      ':- module m.\n:- interface.\n:- import_module msi.\n:- pred p(stream_info).\n:- end_module m.\n', 'm2')
    const p = doc.visitResult!.preds.get('p/1')!
    expect(merTypeToString(p.argTypes[0])).toBe('msi.stream_info')
  })

  it('same-name types in different modules do not unify; missing module is wildcard', () => {
    const ioErr = ctor('error', 'io')
    const otherErr = ctor('error', 'other')
    const bareErr = ctor('error')
    expect(unify(ioErr, otherErr, new Map())).toBe(false)
    expect(unify(ioErr, bareErr, new Map())).toBe(true)
    expect(unify(bareErr, otherErr, new Map())).toBe(true)
    expect(merTypeToString(ioErr)).toBe('io.error')
    expect(merTypeToString(bareErr)).toBe('error')
  })

  it('ambiguous unqualified ref stays unresolved (renders bare name)', async () => {
    await mk(':- module ea.\n:- interface.\n:- type dup.\n:- end_module ea.\n', 'ea')
    await mk(':- module eb.\n:- interface.\n:- type dup.\n:- end_module eb.\n', 'eb')
    const doc = await mk(
      ':- module m.\n:- interface.\n:- pred p(dup).\n:- end_module m.\n', 'm3')
    const p = doc.visitResult!.preds.get('p/1')!
    // ea.dup 与 eb.dup 并存 → 不猜模块，显示裸名（unify 仍按通配兼容）
    expect(merTypeToString(p.argTypes[0])).toBe('dup')
  })

  it('goto type definition reaches non-exported types via ctor.module', async () => {
    // implementation 段声明的类型不进 exportMap：旧路径 exportManager.get(name)
    // 永远落空；ctor.module → typeDocMap 现在能定位到声明文档
    const dep = await mk(
      ':- module mdep.\n' +
      ':- interface.\n' +
      ':- pred make(mdep.t).\n' +
      ':- end_module mdep.\n' +
      ':- implementation.\n' +
      ':- type t.\n' +
      'make(X) :- X = mk_t.\n', 'mdep')
    const doc = await mk(
      ':- module m.\n' +
      ':- interface.\n' +
      ':- import_module mdep.\n' +
      ':- pred p(mdep.t).\n' +
      ':- end_module m.\n' +
      ':- implementation.\n' +
      'p(X) :- mdep.make(X).\n', 'm4')
    // 找 p 子句里 X 的推断类型应为 mdep.t，然后 typeDefinition 应跳到 mdep.m 的类型声明
    const xs = [...doc.visitResult!.inferred.entries()]
      .filter(([t]: any) => t.name === 'X' && (t.syntaxType === 'variable' || String(t.nameArity).startsWith('!')))
      .map(([, i]: any) => i?.type).filter(Boolean)
    expect(xs.some((t: MerType) => merTypeToString(t) === 'mdep.t')).toBe(true)
    const xTerm = [...doc.visitResult!.inferred.entries()]
      .map(([t, i]: any) => ({ t, i }))
      .find(({ t, i }: any) => t.name === 'X' && i?.type && merTypeToString(i.type) === 'mdep.t')!.t
    const locs = await services.providers.typeDefinition({
      textDocument: { uri: doc.uri.toString() },
      position: termRange(xTerm).start,
    } as any)
    expect(locs.length).toBeGreaterThan(0)
    expect(locs[0].uri).toBe(dep.uri.toString())
  })

  it('goto definition resolves nested module qualified calls (io.stream_ops.f)', async () => {
    // 嵌套模块名 io.stream_ops.f 的 term.qualified 是 './2' 链节点（name='.'）：
    // 旧 ModuleManager.get 用 term.name 查 moduleMap 必然落空，
    // funcCandidates / findDefinitionTerm 全断（hover 走全局兜底所以看起来正常）
    const dep = await mk(
      ':- module io.stream_ops.\n' +
      ':- interface.\n' +
      ':- pred do_open_text(string, string, int, stream, system_error, io, io).\n' +
      ':- end_module io.stream_ops.\n' +
      ':- implementation.\n' +
      'do_open_text(_,_,_,_,_,_,_) :- true.\n', 'ios')
    const src =
      ':- module m.\n' +
      ':- interface.\n' +
      ':- import_module io.stream_ops.\n' +
      ':- pred p.\n' +
      ':- end_module m.\n' +
      ':- implementation.\n' +
      'p :- io.stream_ops.do_open_text(A, B, C, D, E, F, G).\n'
    const doc = await mk(src, 'm5')
    const off = src.indexOf('do_open_text', src.indexOf('implementation'))
    const before = src.slice(0, off)
    const position = {
      line: before.split('\n').length - 1,
      character: off - before.lastIndexOf('\n') - 1 + 2,
    }
    const locs = await services.providers.definition({
      textDocument: { uri: doc.uri.toString() },
      position,
    } as any)
    expect(locs.length).toBeGreaterThan(0)
    expect(locs[0].uri).toBe(dep.uri.toString())
  })

  it('goto definition resolves unqualified calls via nested-module imports', async () => {
    // import_module io.stream_ops. 记录的 import 项是规范化模块项
    // （name=stream_ops, qualified=io）；非限定调用走 imports →
    // moduleManager.get → 目标文档 definition 的路径
    const dep = await mk(
      ':- module io.stream_ops.\n' +
      ':- interface.\n' +
      ':- pred do_open_text(string, string, int, stream, system_error, io, io).\n' +
      ':- end_module io.stream_ops.\n' +
      ':- implementation.\n' +
      'do_open_text(_,_,_,_,_,_,_) :- true.\n', 'ios2')
    const src =
      ':- module m.\n' +
      ':- interface.\n' +
      ':- import_module io.stream_ops.\n' +
      ':- pred p.\n' +
      ':- end_module m.\n' +
      ':- implementation.\n' +
      'p :- do_open_text(A, B, C, D, E, F, G).\n'
    const doc = await mk(src, 'm6')
    expect(doc.visitResult!.imports.map(moduleQualifiedName)).toContain('io.stream_ops')
    const off = src.indexOf('do_open_text', src.indexOf('implementation'))
    const before = src.slice(0, off)
    const position = {
      line: before.split('\n').length - 1,
      character: off - before.lastIndexOf('\n') - 1 + 2,
    }
    const locs = await services.providers.definition({
      textDocument: { uri: doc.uri.toString() },
      position,
    } as any)
    expect(locs.length).toBeGreaterThan(0)
    expect(locs[0].uri).toBe(dep.uri.toString())
  })

  it('include_module relative name resolves to submodule; relative qualified call works', async () => {
    // Mercury 语义：include_module 声明的是当前模块的子模块，名字可免全限定——
    // module io 里的 stream_ops = io.stream_ops。visit 侧补成绝对限定名，
    // moduleManager.get / imports 索引 / 模块引用 goto-def 全部命中
    const dep = await mk(
      ':- module io.stream_ops.\n' +
      ':- interface.\n' +
      ':- pred do_open_text(string, string, int, stream, system_error, io, io).\n' +
      ':- end_module io.stream_ops.\n' +
      ':- implementation.\n' +
      'do_open_text(_,_,_,_,_,_,_) :- true.\n', 'ios3')
    const src =
      ':- module io.\n' +
      ':- interface.\n' +
      ':- include_module(stream_ops).\n' +
      ':- pred p.\n' +
      ':- end_module io.\n' +
      ':- implementation.\n' +
      'p :- stream_ops.do_open_text(A, B, C, D, E, F, G).\n'
    const doc = await mk(src, 'io')
    expect(doc.visitResult!.imports.map(moduleQualifiedName)).toContain('io.stream_ops')
    const defAt = async (needle: string, fromIdx: number) => {
      const off = src.indexOf(needle, fromIdx)
      const before = src.slice(0, off)
      return services.providers.definition({
        textDocument: { uri: doc.uri.toString() },
        position: { line: before.split('\n').length - 1, character: off - before.lastIndexOf('\n') - 1 + 2 },
      } as any)
    }
    // include_module(stream_ops) 里的模块引用 → 跳到 io.stream_ops 的 module 声明
    const modLocs = await defAt('stream_ops', 0)
    expect(modLocs.length).toBeGreaterThan(0)
    expect(modLocs[0].uri).toBe(dep.uri.toString())
    // 相对限定调用 stream_ops.do_open_text → 跳到谓词定义
    const callLocs = await defAt('do_open_text', src.indexOf('implementation'))
    expect(callLocs.length).toBeGreaterThan(0)
    expect(callLocs[0].uri).toBe(dep.uri.toString())
  })

  it('scanHeader resolves nested module names (not ".")', () => {
    // module/1 与 import_module/1 的参数是 './2' 链，t.name='.'；
    // 拓扑排序靠点分名匹配 import 目标，必须输出 io.stream_ops
    const src = ':- module io.stream_ops.\n:- interface.\n:- import_module io, io.stream_ops.\n:- pred p.\n:- end_module io.stream_ops.\n'
    const doc = services.documentFactory.fromString(src, URI.parse('file:///hdr.m'))
    const h = scanHeader(doc.parseResult.value)
    expect(h.module).toBe('io.stream_ops')
    expect(h.imports).toContain('io.stream_ops')
    expect(h.imports).toContain('io')
  })
})
