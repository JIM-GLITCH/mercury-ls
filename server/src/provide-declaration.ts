import { DeclarationParams, Location } from 'vscode-languageserver'
import { stream } from './stream'
import { moduleQualifiedName } from './utils'
import type { MercuryServices } from './services'
import type { SymbolEntry } from './document-index'
import { findAtTextDocumentPositionTerm, findModuleDoc, uriTerm, uriTermToLocation } from './provide-definition'

export async function DeclarationProvider(services: MercuryServices, params: DeclarationParams): Promise<Location[]> {
    const termAndUri = await findAtTextDocumentPositionTerm(services, params)
    if (!termAndUri) return []
    const { term, uri } = termAndUri
    const document = services.documents.getOrCreateDocument(uri)!

    // 模块名：跳到该模块的 `:- module` 声明
    if (term.semanticType === 'module') {
        const doc = findModuleDoc(services, term)
        return doc?.moduleTerm ? [uriTermToLocation(uriTerm.create(doc.uri, doc.moduleTerm))] : []
    }

    // 阶段 3 已把引用解析到的定义/声明一起落盘，取其中带签名的一项
    const entry = document.resolved?.get(term)?.find(e => e.signature)
    const candidates: readonly SymbolEntry[] = entry ? [entry] : []
    if (term.qualified) {
        const name = moduleQualifiedName(term.qualified)
        return candidates
            .filter(e => e.module === name || e.doc.moduleName === name)
            .map(e => uriTermToLocation(uriTerm.create(e.doc.uri, e.term)))
    }
    return stream(candidates)
        .map(e => uriTerm.create(e.doc.uri, e.term))
        .map(uriTermToLocation)
        .toArray()
}
