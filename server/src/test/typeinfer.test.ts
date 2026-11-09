import { beforeEach, describe, it, expect } from 'vitest'
import { URI } from 'vscode-uri'
import { CancellationToken } from 'vscode-languageserver'
import { createMercuryServices, type MercuryServices } from '../services'
import { merTypeToString } from '../document-type'
import type { MercuryDocument } from '../document-manager'
import type { Clause, Term } from '../term'

let services: MercuryServices
beforeEach(() => {
    services = createMercuryServices()
})

/** 建文档 → 全局 index → clause body 推导，返回可查 doc.inferred 的文档 */
async function infer(src: string, name: string): Promise<MercuryDocument> {
    const doc = services.documentFactory.fromString(src, URI.parse(`file:///${name}.m`))
    services.documents.addDocument(doc)
    await services.index.update(doc, CancellationToken.None)
    await services.typeInferer.inferDocument(doc)
    return doc
}

/** 取第 idx 条 clause 的定义头（去掉 rule body）与 func 结果项 */
function headOf(doc: MercuryDocument, idx: number): { head: Term; result?: Term } {
    const clause = doc.parseResult.value.args[idx] as Clause
    let t = clause.term
    if (t.nameArity === ':-/2') t = t.args[0]
    let head = t
    let result: Term | undefined
    if (t.nameArity === '=/2') {
        result = t.args[1]
        head = t.args[0]
    }
    return { head, result }
}

/** 推断类型的可读形式；未登记的 term 显式区分出来 */
function typeOf(doc: MercuryDocument, term: Term): string {
    const info = doc.inferred?.get(term)
    return info ? merTypeToString(info.type) : '(no inferred)'
}

describe('typeinfer', () => {
    it('should infer type', async () => {
        const doc = await infer(`
            :- pred p(int).
            p(X) :- Y = mk(1), Y = X.
            `, 'typeinfer')
        const { head } = headOf(doc, 1)
        expect(typeOf(doc, head.args[0])).toBe('int')
    })

    it('推导 pred fact 头参数变量', async () => {
        const doc = await infer(`
            :- pred q(int).
            q(Z).
            `, 'pred_fact')
        const { head } = headOf(doc, 1)
        expect(typeOf(doc, head.args[0])).toBe('int')
    })

    it('推导 func rule 的头参数与结果变量', async () => {
        const doc = await infer(`
            :- func f(int) = int.
            f(A) = B :- A = B.
            `, 'func_rule')
        const { head, result } = headOf(doc, 1)
        expect(typeOf(doc, head.args[0])).toBe('int')
        expect(typeOf(doc, result!)).toBe('int')
    })

    it('无声明时变量保持自由类型，且同名变量共享同一个逻辑变量', async () => {
        const doc = await infer('g(C) = C.', 'no_decl')
        const { head, result } = headOf(doc, 0)
        expect(typeOf(doc, head.args[0])).toBe('unknown')
        expect(typeOf(doc, result!)).toBe('unknown')
        expect(doc.inferred!.get(head.args[0])!.type)
            .toEqual(doc.inferred!.get(result!)!.type)
    })

    it('同一 clause 内同名变量推导出相同类型', async () => {
        const doc = await infer(`
            :- pred pair(int, int).
            pair(X, X).
            `, 'shared_var')
        const { head } = headOf(doc, 1)
        expect(typeOf(doc, head.args[0])).toBe('int')
        expect(typeOf(doc, head.args[1])).toBe('int')
        expect(doc.inferred!.get(head.args[0])!.type)
            .toEqual(doc.inferred!.get(head.args[1])!.type)
    })
})
