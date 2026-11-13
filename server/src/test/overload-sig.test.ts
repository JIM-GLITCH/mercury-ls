import { beforeEach, describe, it, expect } from 'vitest'
import { URI } from 'vscode-uri'
import { Visitor } from '../document-visitor'
import { createMercuryServices, type MercuryServices } from '../services'
import { merTypeToString } from '../document-type'

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

// 回归：同名同元数重载（如 int.+/2 与 uint8.+/2）必须按实参类型经试解消歧，
// 不能取 funcMap/funcs 里碰巧最后注册的那个签名。
describe('overloaded func/pred disambiguation by trial inference', () => {
  it('f(int,int)=int vs f(uint8,uint8)=uint8: int args pick int sig', async () => {
    await mk(
      ':- module ma.\n:- interface.\n:- func f(int, int) = int.\n:- end_module ma.\n',
      'ma',
    )
    await mk(
      ':- module mb.\n:- interface.\n:- type uint8.\n:- func f(uint8, uint8) = uint8.\n:- end_module mb.\n',
      'mb',
    )
    const docM = await mk(
      ':- module m.\n' +
      ':- interface.\n' +
      ':- implementation.\n' +
      ':- import_module ma.\n' +
      ':- import_module mb.\n' +
      'p(X, Y, Z) :- X = 1, Y = 2, Z = f(X, Y).\n' +
      ':- end_module m.\n',
      'm',
    )
    const inf = docM.visitResult!.inferred
    const fTerms = collectTerms(docM.parseResult.value, 'f/2').filter((t: any) => inf.get(t))
    expect(fTerms.length).toBeGreaterThan(0)
    for (const t of fTerms) {
      const i = inf.get(t) as any
      expect(i?.category).toBe('func')
      expect(merTypeToString(i.type)).toBe('int')
      // 选中的签名应是 int 版本（供 hover 显示）
      expect(i.sig?.argTypes.map(merTypeToString)).toEqual(['int', 'int'])
    }
    // Z 应推出 int
    const zTerms = collectTerms(docM.parseResult.value, 'Z/0').filter((t: any) => inf.get(t))
    expect(zTerms.length).toBeGreaterThan(0)
    for (const t of zTerms) expect(merTypeToString((inf.get(t) as any).type)).toBe('int')
  })

  it('verified func overload beats cross-module constructor (int args pick int.- over pair ctor)', async () => {
    // `-`/2 同时是 int.-/2 函数与 pair 的 `-`/2 构造子；实参类型已知 int 时
    // 试解唯一选出 int.-，应标 func 且结果类型 int（SizeDiff = H0 - H 场景）
    await mk(
      ':- module mint3.\n:- interface.\n:- func int - int = int.\n:- end_module mint3.\n',
      'mint3',
    )
    await mk(
      ':- module mpair3.\n:- interface.\n:- type pair(K, V) ---> K - V.\n:- end_module mpair3.\n',
      'mpair3',
    )
    const docM = await mk(
      ':- module m3.\n' +
      ':- interface.\n' +
      ':- implementation.\n' +
      ':- import_module mint3.\n' +
      'p(A, B, S) :- A = 1, B = 2, S = A - B.\n' +
      ':- end_module m3.\n',
      'm3',
    )
    const inf = docM.visitResult!.inferred
    const minusTerms = collectTerms(docM.parseResult.value, '-/2').filter((t: any) => inf.get(t))
    expect(minusTerms.length).toBeGreaterThan(0)
    for (const t of minusTerms) {
      const i = inf.get(t) as any
      expect(i?.category).toBe('func')
      expect(merTypeToString(i.type)).toBe('int')
      expect(i.sig?.argTypes.map(merTypeToString)).toEqual(['int', 'int'])
    }
  })

  it('compound/literal args still disambiguate (int_expr + 1 picks int.+)', async () => {
    // `High - Low + 1`：+ 的左实参是复合项、右实参是字面量。
    // inferTerm 不会把复合项/字面量的推出类型与形参强制合一，
    // trialSig 必须补「推出类型 vs 形参」的合一检查，否则所有重载并列 → 不标注
    await mk(
      ':- module ma4.\n:- interface.\n:- func int + int = int.\n:- func int - int = int.\n:- end_module ma4.\n',
      'ma4',
    )
    await mk(
      ':- module mb4.\n:- interface.\n:- type uint8.\n:- func uint8 + uint8 = uint8.\n:- func uint8 - uint8 = uint8.\n:- end_module mb4.\n',
      'mb4',
    )
    const docM = await mk(
      ':- module m4.\n' +
      ':- interface.\n' +
      ':- implementation.\n' +
      ':- import_module ma4.\n' +
      ':- import_module mb4.\n' +
      'p(H, L, S) :- H = 5, L = 2, S = H - L + 1.\n' +
      ':- end_module m4.\n',
      'm4',
    )
    const inf = docM.visitResult!.inferred
    const plusTerms = collectTerms(docM.parseResult.value, '+/2').filter((t: any) => inf.get(t))
    expect(plusTerms.length).toBeGreaterThan(0)
    for (const t of plusTerms) {
      const i = inf.get(t) as any
      expect(i?.category).toBe('func')
      expect(merTypeToString(i.type)).toBe('int')
      expect(i.sig?.argTypes.map(merTypeToString)).toEqual(['int', 'int'])
    }
    // S 也应推出 int
    const sTerms = collectTerms(docM.parseResult.value, 'S/0').filter((t: any) => inf.get(t))
    for (const t of sTerms) expect(merTypeToString((inf.get(t) as any).type)).toBe('int')
  })

  it('ambiguous args (unknown types) keep func unlabeled by inference', async () => {
    await mk(
      ':- module ma2.\n:- interface.\n:- func f(int, int) = int.\n:- end_module ma2.\n',
      'ma2',
    )
    await mk(
      ':- module mb2.\n:- interface.\n:- type uint8.\n:- func f(uint8, uint8) = uint8.\n:- end_module mb2.\n',
      'mb2',
    )
    const docM = await mk(
      ':- module m2.\n' +
      ':- interface.\n' +
      ':- implementation.\n' +
      ':- import_module ma2.\n' +
      ':- import_module mb2.\n' +
      'p(X, Y, Z) :- Z = f(X, Y).\n' +
      ':- end_module m2.\n',
      'm2',
    )
    const inf = docM.visitResult!.inferred
    const fTerms = collectTerms(docM.parseResult.value, 'f/2').filter((t: any) => inf.get(t))
    for (const t of fTerms) {
      const i = inf.get(t) as any
      // 实参类型未知 → 不猜，category 不标 func
      expect(i?.category).not.toBe('func')
    }
  })
})

// 回归：freeze/2 式延迟消歧——构造子消歧失败时挂起，等结果类型被后续
// goal 的签名约束绑定后唤醒重跑（stream/4 双构造子场景）
describe('frozen delayed disambiguation', () => {
  it('cross-module stream/4 ctor resolved by later call signature', async () => {
    // 构造子在导入模块里：无类型上下文时 constrs 为空（跨模块构造子只在
    // expCtor 时收集），freeze 必须靠 hasCrossConstrs 检测到候选存在才挂起
    await mk(
      ':- module msi.\n' +
      ':- interface.\n' +
      ':- type stream_info ---> stream(int, int, int, int).\n' +
      ':- type maybe_stream_info ---> stream(int, int, int, int) ; unknown_stream.\n' +
      ':- end_module msi.\n',
      'msi',
    )
    const docM = await mk(
      ':- module mf.\n' +
      ':- interface.\n' +
      ':- implementation.\n' +
      ':- import_module msi.\n' +
      ':- pred insert_stream_info(int, msi.stream_info, int, int).\n' +
      'p(StreamInfo, NewStream) :-\n' +
      '    StreamInfo = stream(OpenCount, append, binary, file(FileName)),\n' +
      '    insert_stream_info(NewStream, StreamInfo, 0, 0).\n' +
      ':- end_module mf.\n',
      'mf',
    )
    const inf = docM.visitResult!.inferred
    const streamTerms = collectTerms(docM.parseResult.value, 'stream/4').filter((t: any) => inf.get(t))
    expect(streamTerms.length).toBeGreaterThan(0)
    for (const t of streamTerms) {
      const i = inf.get(t) as any
      // 消歧失败时挂起；insert_stream_info 把 StreamInfo 绑到 stream_info 后
      // 唤醒重跑，应选中 stream_info.stream/4 构造子
      expect(i?.category).toBe('constructor')
      expect(merTypeToString(i.type)).toBe('stream_info')
    }
    // StreamInfo 变量也应显示 stream_info
    const siTerms = collectTerms(docM.parseResult.value, 'StreamInfo/0').filter((t: any) => inf.get(t))
    expect(siTerms.length).toBeGreaterThan(0)
    for (const t of siTerms) {
      expect(merTypeToString((inf.get(t) as any).type)).toBe('stream_info')
    }
  })

  it('repro: ;/2 branch + !IO state var + cross-module pred call', async () => {
    await mk(
      ':- module msi2.\n' +
      ':- interface.\n' +
      ':- type stream_info ---> stream(int, int, int, int).\n' +
      ':- type maybe_stream_info ---> stream(int, int, int, int) ; unknown_stream.\n' +
      ':- type stream.\n' +
      ':- type io.\n' +
      ':- pred insert_stream_info(stream::in, stream_info::in, io::di, io::uo).\n' +
      ':- end_module msi2.\n',
      'msi2',
    )
    const docM = await mk(
      ':- module mrepro.\n' +
      ':- interface.\n' +
      ':- implementation.\n' +
      ':- import_module msi2.\n' +
      'open_append(FileName, Result, !IO) :-\n' +
      '    (\n' +
      '        FileName = "x",\n' +
      '        Result = error(fail)\n' +
      '    ;\n' +
      '        OpenCount = 0,\n' +
      '        Result = ok(stream),\n' +
      '        StreamInfo = stream(OpenCount, append, binary, file(FileName)),\n' +
      '        insert_stream_info(NewStream, StreamInfo, !IO)\n' +
      '    ).\n' +
      ':- end_module mrepro.\n',
      'mrepro',
    )
    const inf = docM.visitResult!.inferred
    const streamTerms = collectTerms(docM.parseResult.value, 'stream/4').filter((t: any) => inf.get(t))
    expect(streamTerms.length).toBeGreaterThan(0)
    for (const t of streamTerms) {
      const i = inf.get(t) as any
      expect(i?.category).toBe('constructor')
      expect(merTypeToString(i.type)).toBe('stream_info')
    }
    const siTerms = collectTerms(docM.parseResult.value, 'StreamInfo/0').filter((t: any) => inf.get(t))
    expect(siTerms.length).toBeGreaterThan(0)
    for (const t of siTerms) {
      expect(merTypeToString((inf.get(t) as any).type)).toBe('stream_info')
    }
  })

  it('still-ambiguous cross-module ctor stays unlabeled when no constraint arrives', async () => {
    await mk(
      ':- module mgi.\n' +
      ':- interface.\n' +
      ':- type stream_info ---> stream(int, int, int, int).\n' +
      ':- type maybe_stream_info ---> stream(int, int, int, int) ; unknown_stream.\n' +
      ':- end_module mgi.\n',
      'mgi',
    )
    const docM = await mk(
      ':- module mg.\n' +
      ':- interface.\n' +
      ':- implementation.\n' +
      ':- import_module mgi.\n' +
      'p(StreamInfo) :- StreamInfo = stream(1, 2, 3, 4).\n' +
      ':- end_module mg.\n',
      'mg',
    )
    const inf = docM.visitResult!.inferred
    const streamTerms = collectTerms(docM.parseResult.value, 'stream/4').filter((t: any) => inf.get(t))
    expect(streamTerms.length).toBeGreaterThan(0)
    for (const t of streamTerms) {
      const i = inf.get(t) as any
      // 没有任何约束到达 → 保持无类别，不误标
      expect(i?.category).toBeUndefined()
    }
  })
})
