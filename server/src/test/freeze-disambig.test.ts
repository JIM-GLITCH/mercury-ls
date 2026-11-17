import { describe, it, expect, beforeEach } from 'vitest'
import { URI } from 'vscode-uri'
import { Visitor } from '../document-visitor'
import { createMercuryServices, type MercuryServices } from '../services'
import { merTypeToString } from '../document-type'

let services: MercuryServices
beforeEach(() => { services = createMercuryServices() })
const token = { isCancellationRequested: false, onCancellationRequested: () => undefined } as any

async function visit(name: string, src: string) {
    const doc = services.documentFactory.fromString(src, URI.parse(`file:///${name}.m`))
    services.documents.addDocument(doc)
    await new Visitor(services).visit(doc, token, true)
    const mod = doc.visitResult!.module
    if (mod) services.moduleManager.set(mod, doc)
    services.exportManager.set(doc)
    return doc
}

const LIBS = async () => {
    await visit('list', `:- module(list).\n:- interface.\n:- func list(T) ++ list(T) = list(T).\n`)
    await visit('string', `:- module(string).\n:- interface.\n:- func string ++ string = string.\n`)
}

describe('freeze-all disambiguation', () => {
    it('fully unknown args stay ambiguous -> error', async () => {
        await LIBS()
        const doc = await visit('main',
            `:- module(main).\n:- import_module list.\n:- import_module string.\n` +
            `:- pred p(A, B, C).\n` +
            `p(A, B, C) :- C = A ++ B.\n`)
        let found: any
        doc.visitResult!.inferred.forEach((info: any, term: any) => {
            if (term.name === '++' && !found) found = { info, term }
        })
        console.log('type=', merTypeToString(found.info.type), 'sig=', found.info.sig?.module)
        const errs = doc.visitResult!.errors.filter(e => e.message.includes('signature'))
        console.log('errors:', errs.map(e => e.message))
        expect(errs.length).toBe(1)
    })

    it('args bound later -> freeze retry resolves', async () => {
        await LIBS()
        const doc = await visit('main',
            `:- module(main).\n:- import_module list.\n:- import_module string.\n` +
            `:- pred p(A, B, C).\n` +
            `p(A, B, C) :- C = A ++ B, A = [1], B = [2].\n`)
        let found: any
        doc.visitResult!.inferred.forEach((info: any, term: any) => {
            if (term.name === '++' && !found) found = { info, term }
        })
        console.log('type=', merTypeToString(found.info.type), 'sig=', found.info.sig?.module)
        const errs = doc.visitResult!.errors.filter(e => e.message.includes('signature'))
        console.log('errors:', errs.map(e => e.message))
        expect(found.info.sig?.module).toBe('list')
        expect(errs.length).toBe(0)
    })

    it('ambiguous head sig resolves via body binding', async () => {
        const doc = await visit('main',
            `:- module(main).\n` +
            `:- pred p(list(int)).\n:- pred p(string).\n` +
            `p(X) :- X = [1].\n`)
        const errs = doc.visitResult!.errors.filter(e => e.message.includes('signature'))
        console.log('errors:', errs.map(e => e.message))
        expect(errs.length).toBe(0)
    })

    it('ambiguous head sig stays -> error', async () => {
        const doc = await visit('main',
            `:- module(main).\n` +
            `:- pred q(list(int)).\n:- pred q(string).\n` +
            `q(X) :- true.\n`)
        const errs = doc.visitResult!.errors.filter(e => e.message.includes('signature'))
        console.log('errors:', errs.map(e => e.message))
        expect(errs.length).toBe(1)
    })
})
