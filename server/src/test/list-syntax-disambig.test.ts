import { describe, it, expect, beforeEach } from 'vitest'
import { URI } from 'vscode-uri'
import { Visitor } from '../document-visitor'
import { createMercuryServices, type MercuryServices } from '../services'
import { merTypeToString } from '../document-type'

let services: MercuryServices
beforeEach(() => { services = createMercuryServices() })
const token = { isCancellationRequested: false, onCancellationRequested: () => undefined } as any

async function mk(name: string, src: string) {
    const doc = services.documentFactory.fromString(src, URI.parse(`file:///${name}.m`))
    services.documents.addDocument(doc)
    await new Visitor(services).visit(doc, token, true)
    const mod = doc.visitResult!.module
    if (mod) services.moduleManager.set(mod, doc)
    services.exportManager.set(doc)
    return doc
}

function sigOf(doc: any, termName: string) {
    const out: string[] = []
    doc.visitResult!.inferred.forEach((info: any, term: any) => {
        if (term.name === termName) {
            out.push(`type=${merTypeToString(info.type)} sig=${info.sig ? info.sig.name + ' arg0=' + merTypeToString(info.sig.argTypes[0]) : '-'}`)
        }
    })
    return out
}

describe('++ disambiguation string vs list', () => {
    it('variants', async () => {
        await mk('string', `:- module(string).\n:- interface.\n:- func string ++ string = string.\n`)
        await mk('list', `:- module(list).\n:- interface.\n:- func list(T) ++ list(T) = list(T).\n`)
        const doc = await mk('user', `:- module(user).\n:- import_module(string).\n:- import_module(list).\n\np :- X = [1,2] ++ [3].\nq :- S = "a" ++ "b".\nr(A, B, C) :- C = A ++ B.\ns(L) :- L = [1] ++ [2], q2(L).\nq2(X).\nt(A,B,C) :- is_list(A), C = A ++ B.\n`)
        for (const line of sigOf(doc, '++')) console.log(line)
    })
    it('local decl does not shadow import: list args pick list.++ inside string.m-like module', async () => {
        await mk('string', `:- module(string).\n:- interface.\n:- func string ++ string = string.\n`)
        await mk('list', `:- module(list).\n:- interface.\n:- func list(T) ++ list(T) = list(T).\n`)
        // 模拟 string.m：本模块自声明 string.++ 且 import list，
        // list(int) 实参的 ++ 必须消歧到 list.++（Mercury 同名候选全可见）
        const doc = await mk('mymod', `:- module(mymod).\n:- import_module(string).\n:- import_module(list).\n:- func string ++ string = string.\n\nencode(A, B, C) :- C = A ++ B.\nuse :- X = [1] ++ [2].\n`)
        const lines = sigOf(doc, '++')
        for (const line of lines) console.log(line)
        // use 子句的 ++（list 字面量实参）必须选中 list.++
        const listPick = lines.filter(l => l.includes('arg0=list'))
        expect(listPick.length).toBeGreaterThan(0)
    })
})
