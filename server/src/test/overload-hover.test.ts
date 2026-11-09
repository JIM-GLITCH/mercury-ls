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

describe('overloaded builtin operator hover', () => {
  it('shows the overload matching the literal argument types, not the first indexed declaration', async () => {
    // 故意让 float 版先被索引：模拟工作区里标准库模块先构建
    const floats = add([
      ':- module floats.',
      ':- interface.',
      ':- func (float::in) + (float::in) = (float::uo) is det.',
      ':- end_module floats.',
    ].join('\n'), 'floats')
    const ints = add([
      ':- module ints.',
      ':- interface.',
      ':- func int + int = int.',
      ':- end_module ints.',
    ].join('\n'), 'ints')
    const m = add([
      ':- module m.',
      ':- interface.',
      ':- end_module m.',
      ':- implementation.',
      ':- pred f(int).',
      'f(X) :- X = 1+1.',
    ].join('\n'), 'm')

    await services.builder.build([floats, ints, m], token)
    // 用户看到 `mode +(in, in) = (uo)`：uo 来自这条声明返回值的 ::uo 注解
    expect(services.index.get(floats)!.funcs.get('+/2')?.resultMode).toBe('uo')

    const plus = collectTerms(m.parseResult.value, '+/2')[0]
    expect(plus).toBeDefined()
    const hover: any = await services.providers.hover({
      textDocument: { uri: m.uri.toString() },
      position: termTokenRange(plus).start,
    } as any)
    const value: string = hover.contents.value

    // 实参是整数字面量，应显示 int 版本；不能因为 float 版先入全局表就抄它
    expect(value).toContain('type +(int, int) = int')
    expect(value).toContain('mode +(in, in) = (out)')
    // 限定名要跟随实际选中的 int 版签名，而不是索引里第一个 float 版
    expect(value).toContain('(func) ints.+/2')
    expect(value).not.toContain('float')
    expect(value).not.toContain('uo')
  })
})
