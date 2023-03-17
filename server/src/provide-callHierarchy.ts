import { CallHierarchyIncomingCall, CallHierarchyIncomingCallsParams, CallHierarchyItem, CallHierarchyOutgoingCall, CallHierarchyOutgoingCallsParams, CallHierarchyPrepareParams, CancellationToken, SymbolKind } from 'vscode-languageserver'
import {   nameArity, sameArity, sameSemanticType, sleep, termTokenRange, tokenRange } from './utils'
import { Term, termRange } from './term'
import { SemanticType } from "./document-visitor"
import { stream } from './stream'
import { findDefTerms, findAtTextDocumentPositionTerm, uriTerm } from './provide-definition'
import { MercuryDocument, mercuryDocuments } from './document-manager'
import { equalQualified, moduleManager } from './document-moduleManager'
import { URI } from 'vscode-uri'
/**
 * find definition term as the callheirarchyItem
 * @param params 
 * @returns 
 */
export async function prepareCallHierarchyProvider(params:CallHierarchyPrepareParams,token:CancellationToken){
    let uriAndTerm  = await findAtTextDocumentPositionTerm(params)
    if(!uriAndTerm) return;
    return findDefTerms(uriAndTerm)
        .map(x => [uriTermToCallHierarchyItem(x)] )
        .head()

}

export async function outgoingCallsProvider(params:CallHierarchyOutgoingCallsParams):Promise<CallHierarchyOutgoingCall[]>{
    let {item:{uri:uriString,selectionRange:{start:position}}} = params;
    let uri = URI.parse(uriString)
    let res = await findAtTextDocumentPositionTerm({textDocument:{uri:uriString},position});
    if(!res) return [];
    let term = res.term
    if (term.semanticType == "module"){
        return findModuleOutgoingCalls(res)
    }
    return findDefTerms(uriTerm.create(uri,term))
        .map(x=>(x.term.clause?.called??[]))
        .flat()
        .map(ref =>uriTermToCallHierarchyOutgoingCall({uri,term:ref}))
        .nonNullable().toArray()

}

export async function incomingCallsProvider(params:CallHierarchyIncomingCallsParams) {
    let {item:{uri,selectionRange:{start:position}}} = params;
    let res = await findAtTextDocumentPositionTerm({textDocument:{uri},position});
    if(!res) return [];
    let term = res.term;
    if(term.semanticType == "variable"){
        return [];
    }
    if(term.semanticType == "module"){
        return findModuleIncmoingCalls(res)
    }
    return  stream(mercuryDocuments.all)
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
        name :nameArity(term),
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

function uriTermToCallHierarchyOutgoingCall(uriTerm: uriTerm):CallHierarchyOutgoingCall|undefined{
    let to = findDefTerms(uriTerm).map(uriTermToCallHierarchyItem).head()
    return to
        ?   {
                to,
                fromRanges:[termTokenRange(uriTerm.term)]
            }
        :   undefined;
}

function findModuleOutgoingCalls({ uri, term}:uriTerm): CallHierarchyOutgoingCall[]  {
    let document = moduleManager.get(term);
    if(!document)
        return []
    return stream(document.visitResult?.imports??[])
        .map(x=>moduleManager.get(x)?.visitResult?.module)
        .nonNullable()
        .map(moduleTerm=>uriTermToCallHierarchyOutgoingCall({uri,term:moduleTerm}))
        .nonNullable().toArray()
}

function findModuleIncmoingCalls(uriTerm: { uri: URI; term: Term }) {
    let {uri,term} = uriTerm;
    let doc = mercuryDocuments.getOrCreateDocument(uri)
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

