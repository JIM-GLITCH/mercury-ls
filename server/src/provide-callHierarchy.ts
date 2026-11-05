import { CallHierarchyIncomingCall, CallHierarchyIncomingCallsParams, CallHierarchyItem, CallHierarchyOutgoingCall, CallHierarchyOutgoingCallsParams, CallHierarchyPrepareParams, CancellationToken, SymbolKind } from 'vscode-languageserver'
import {   semanticNameArityOf, sameArity, sameSemanticType, sleep, termTokenRange, tokenRange } from './utils'
import { Term, termRange } from './term'
import { SemanticType } from "./document-visitor"
import { stream } from './stream'
import { findDefTerms, findAtTextDocumentPositionTerm, uriTerm } from './provide-definition'
import { MercuryDocument } from './document-manager'
import { equalQualified } from './document-moduleManager'
import { URI } from 'vscode-uri'
import type { MercuryServices } from './services'
/**
 * find definition term as the callheirarchyItem
 * @param params 
 * @returns 
 */
export async function prepareCallHierarchyProvider(services: MercuryServices, params:CallHierarchyPrepareParams,token:CancellationToken){
    let uriAndTerm  = await findAtTextDocumentPositionTerm(services, params)
    if(!uriAndTerm) return;
    return findDefTerms(services, uriAndTerm)
        .map(x => [uriTermToCallHierarchyItem(x)] )
        .head()

}

export async function outgoingCallsProvider(services: MercuryServices, params:CallHierarchyOutgoingCallsParams):Promise<CallHierarchyOutgoingCall[]>{
    let {item:{uri:uriString,selectionRange:{start:position}}} = params;
    let uri = URI.parse(uriString)
    let res = await findAtTextDocumentPositionTerm(services, {textDocument:{uri:uriString},position});
    if(!res) return [];
    let term = res.term
    if (term.semanticType == "module"){
        return findModuleOutgoingCalls(services, res)
    }
    return findDefTerms(services, uriTerm.create(uri,term))
        .map(x=>(x.term.clause?.called??[]))
        .flat()
        .map(ref =>uriTermToCallHierarchyOutgoingCall(services, {uri,term:ref}))
        .nonNullable().toArray()

}

export async function incomingCallsProvider(services: MercuryServices, params:CallHierarchyIncomingCallsParams) {
    let {item:{uri,selectionRange:{start:position}}} = params;
    let res = await findAtTextDocumentPositionTerm(services, {textDocument:{uri},position});
    if(!res) return [];
    let term = res.term;
    if(term.semanticType == "variable"){
        return [];
    }
    if(term.semanticType == "module"){
        return findModuleIncmoingCalls(services, res)
    }
    return  stream(services.documents.all)
    .map(doc =>{
        let uri = doc.uri
        return stream(doc.visitResult?.reference.get(term.name)??[]).map(x=>({uri,term:x}))
    })
    .flat()
    .map(x=>uriTermToCallHierarchyIncomingItem(x)).toArray()
}


function SemanticTypeToSymbolKind(semanticType?: SemanticType ): SymbolKind {
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
function findRefTermInDocument(term:Term,document:MercuryDocument){
    let uri = document.uri.toString()
    let terms = document.visitResult?.reference.get(term.name);
    let refterms = stream(terms??[])
    .filter(x=>sameArity(x,term))
    .map(x=>x.clause?.called??[])
    .flat()
    .map(x =>({
        uri,
        term:x
    }))
    return refterms
}


function uriTermToCallHierarchyItem(params: uriTerm):CallHierarchyItem {
    let {term,uri} = params;
    return {
        name :semanticNameArityOf(term),
        kind :SemanticTypeToSymbolKind(term.semanticType),
        uri:uri.toString(),
        range:termRange(term),
        selectionRange:termTokenRange(term)
    }
}

function uriTermToCallHierarchyIncomingItem(params: uriTerm):CallHierarchyIncomingCall {
    let {term,uri} = params;
    return {
        from:uriTermToCallHierarchyItem({uri ,term:term.clause!.callee!}),
        fromRanges:[termTokenRange(term)]
    }
}

function uriTermToCallHierarchyOutgoingCall(services: MercuryServices, uriTerm: uriTerm):CallHierarchyOutgoingCall|undefined{
    let to = findDefTerms(services, uriTerm).map(uriTermToCallHierarchyItem).head()
    return to
        ?   {
                to,
                fromRanges:[termTokenRange(uriTerm.term)]
            }
        :   undefined;
}

function findModuleOutgoingCalls(services: MercuryServices, { uri, term}:uriTerm): CallHierarchyOutgoingCall[]  {
    let document = services.moduleManager.get(term);
    if(!document)
        return []
    return stream(document.visitResult?.imports??[])
        .map(x=>services.moduleManager.get(x)?.visitResult?.module)
        .nonNullable()
        .map(moduleTerm=>uriTermToCallHierarchyOutgoingCall(services, {uri,term:moduleTerm}))
        .nonNullable().toArray()
}

function findModuleIncmoingCalls(services: MercuryServices, uriTerm: { uri: URI; term: Term }) {
    let {uri,term} = uriTerm;
    let doc = services.documents.getOrCreateDocument(uri)
    let candidates = doc.importedByDocs
    let res =  stream(candidates).map(candidateDoc =>{
        let module = candidateDoc.visitResult?.module
        if(module){
            return {
                from:uriTermToCallHierarchyItem({uri: doc.uri, term:module}),
                fromRanges:[termTokenRange(doc.visitResult?.imports.find(x=>equalQualified(x,term))!)]
            }
        }
    }).nonNullable()
    return res
}
