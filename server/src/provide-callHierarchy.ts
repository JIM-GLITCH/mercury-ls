import { CallHierarchyIncomingCall, CallHierarchyIncomingCallsParams, CallHierarchyItem, CallHierarchyOutgoingCall, CallHierarchyOutgoingCallsParams, CallHierarchyPrepareParams, CancellationToken, SymbolKind } from 'vscode-languageserver'
import { semanticNameArityOf, sameArity, termTokenRange, equalQualified } from './utils'
import { Term, termRange } from './term'
import type { SemanticType } from './document-index'
import { stream } from './stream'
import { findDefTerms, findAtTextDocumentPositionTerm, findModuleDoc, uriTerm } from './provide-definition'
import { URI } from 'vscode-uri'
import type { MercuryServices } from './services'

/**
 * find definition term as the callheirarchyItem
 */
export async function prepareCallHierarchyProvider(services: MercuryServices, params: CallHierarchyPrepareParams, token: CancellationToken) {
    let uriAndTerm = await findAtTextDocumentPositionTerm(services, params)
    if (!uriAndTerm) return undefined
    return findDefTerms(services, uriAndTerm)
        .map(x => [uriTermToCallHierarchyItem(x)])
        .head()
}

export async function outgoingCallsProvider(services: MercuryServices, params: CallHierarchyOutgoingCallsParams): Promise<CallHierarchyOutgoingCall[]> {
    let { item: { uri: uriString, selectionRange: { start: position } } } = params;
    let uri = URI.parse(uriString)
    let res = await findAtTextDocumentPositionTerm(services, { textDocument: { uri: uriString }, position });
    if (!res) return [];
    let term = res.term
    if (term.semanticType == "module") {
        return findModuleOutgoingCalls(services, res)
    }
    return findDefTerms(services, uriTerm.create(uri, term))
        .map(x => (x.term.clause?.called ?? []))
        .flat()
        .map(ref => uriTermToCallHierarchyOutgoingCall(services, { uri, term: ref }))
        .nonNullable().toArray()
}

export async function incomingCallsProvider(services: MercuryServices, params: CallHierarchyIncomingCallsParams) {
    let { item: { uri, selectionRange: { start: position } } } = params;
    let res = await findAtTextDocumentPositionTerm(services, { textDocument: { uri }, position });
    if (!res) return [];
    let term = res.term;
    if (term.semanticType == "variable") return [];
    if (term.semanticType == "module") return findModuleIncomingCalls(services, res)

    // 阶段 3 已落盘所有引用项，按名字 + 元数直接筛，无需重新解析
    return stream(services.documents.all)
        .flatMap(doc => stream(doc.references ?? [])
            .filter(x => x.name === term.name && sameArity(x, term))
            .map(x => ({ uri: doc.uri, term: x })))
        .map(x => uriTermToCallHierarchyIncomingItem(x))
        .nonNullable().toArray()
}

function SemanticTypeToSymbolKind(semanticType?: SemanticType): SymbolKind {
    switch (semanticType) {
        case 'func':
            return SymbolKind.Operator
        case 'pred':
            return SymbolKind.Function
        case 'type':
            return SymbolKind.Struct
        case 'module':
            return SymbolKind.Module
        case 'variable':
            return SymbolKind.Variable
        default:
            return SymbolKind.Function
    }
}

function uriTermToCallHierarchyItem(params: uriTerm): CallHierarchyItem {
    let { term, uri } = params;
    return {
        name: semanticNameArityOf(term),
        kind: SemanticTypeToSymbolKind(term.semanticType),
        uri: uri.toString(),
        range: termRange(term),
        selectionRange: termTokenRange(term)
    }
}

function uriTermToCallHierarchyIncomingItem(params: uriTerm): CallHierarchyIncomingCall | undefined {
    let { term, uri } = params;
    const callee = term.clause?.callee
    if (!callee) return undefined
    return {
        from: uriTermToCallHierarchyItem({ uri, term: callee }),
        fromRanges: [termTokenRange(term)]
    }
}

function uriTermToCallHierarchyOutgoingCall(services: MercuryServices, uriTerm: uriTerm): CallHierarchyOutgoingCall | undefined {
    let to = findDefTerms(services, uriTerm).map(uriTermToCallHierarchyItem).head()
    return to
        ? {
            to,
            fromRanges: [termTokenRange(uriTerm.term)]
        }
        : undefined;
}

function findModuleOutgoingCalls(services: MercuryServices, { uri, term }: uriTerm): CallHierarchyOutgoingCall[] {
    let document = findModuleDoc(services, term)
    if (!document) return []
    return stream(document.importModules ?? [])
        .map(x => findModuleDoc(services, x)?.moduleTerm)
        .nonNullable()
        .map(moduleTerm => uriTermToCallHierarchyOutgoingCall(services, { uri, term: moduleTerm }))
        .nonNullable().toArray()
}

function findModuleIncomingCalls(services: MercuryServices, { uri, term }: uriTerm): CallHierarchyIncomingCall[] {
    const res: CallHierarchyIncomingCall[] = []
    for (const doc of services.documents.all) {
        const importTerm = (doc.importModules ?? []).find(x => equalQualified(x, term))
        const moduleTerm = doc.moduleTerm
        if (!importTerm || !moduleTerm) continue
        res.push({
            from: uriTermToCallHierarchyItem({ uri: doc.uri, term: moduleTerm }),
            fromRanges: [termTokenRange(importTerm)],
        })
    }
    return res
}
