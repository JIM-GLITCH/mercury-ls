import { DeclarationParams, Location } from 'vscode-languageserver'
import { stream } from './stream'
import { moduleQualifiedName, semanticArityOf } from './utils'
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

    // 阶段 3 已把引用解析到声明项；若当前是子句头定义，则按名字在全局符号表里取带签名的声明
    const resolved = document.resolved?.get(term)?.[0]
    let candidates: readonly SymbolEntry[] = resolved?.signature
        ? [resolved]
        : services.index.get(term.name).filter(e => !!e.signature && e.arity === semanticArityOf(term))

    if (term.qualified) {
        const name = moduleQualifiedName(term.qualified)
        candidates = candidates.filter(e => e.module === name || e.doc.moduleName === name)
    }
    return stream(candidates)
        .map(e => uriTerm.create(e.doc.uri, e.term))
        .map(uriTermToLocation)
        .toArray()
}
