import { describe, it, expect, beforeEach } from 'vitest'
import { URI } from 'vscode-uri'
import { createMercuryServices, type MercuryServices } from '../services'

let services: MercuryServices

describe('CLP 调试', () => {
    beforeEach(() => {
        services = createMercuryServices()
    })

    it('调试函数规则', async () => {
        const src = `
            :- func f(int) = int.
            f(A) = B :- A = B.
        `
        
        const doc = services.documentFactory.fromString(src, URI.parse('file:///test.m'))
        services.documents.addDocument(doc)
        await services.index.update(doc, { isCancellationRequested: false } as any)
        await services.typeInferer.inferDocument(doc)
        
        console.log('文档推断结果:', doc.inferred)
        
        // 检查变量 A 的类型
        const clause = doc.parseResult.value.args[1]
        const head = clause.term.args[0] // f(A)
        const argA = head.args[0]
        
        console.log('变量 A:', argA.name, '类型:', doc.inferred?.get(argA))
        
        // 检查变量 B 的类型  
        const resultB = clause.term.args[1]
        console.log('变量 B:', resultB.name, '类型:', doc.inferred?.get(resultB))
        
        expect(doc.inferred?.size).toBeGreaterThan(0)
    })
})