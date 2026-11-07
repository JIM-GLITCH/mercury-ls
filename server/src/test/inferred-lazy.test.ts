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

describe('inferred types resolve when read', () => {
  it('a list term recorded before its element type is bound shows the final type', async () => {
    const doc = services.documentFactory.fromString([
      ':- pred p(int).',
      'p(X) :- Y = mk(1), Y = X.',
    ].join('\n'), URI.parse('file:///lazy.m'))
    services.documents.addDocument(doc)
    await services.builder.build([doc], token)

    // mk/1 无声明：写入 inferred 时结果类型是自由变量，
    // 之后 `Y = X` 才把它绑定到 head 声明里的 int
    const mk = collect(doc.parseResult.value, (t: any) => t.nameArity === 'mk/1')[0]
    expect(mk).toBeDefined()
    expect(merTypeToString(doc.visitResult!.inferred.get(mk)!.type)).toBe('int')

    const hover: any = await services.providers.hover({
      textDocument: { uri: doc.uri.toString() },
      position: termTokenRange(mk).start,
    } as any)
    expect(hover?.contents?.value).not.toContain('unknown')
  })
})
