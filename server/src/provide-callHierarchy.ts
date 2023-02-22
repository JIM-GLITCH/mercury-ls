import { CallHierarchyIncomingCall, CallHierarchyIncomingCallsParams, CallHierarchyItem, CallHierarchyOutgoingCall, CallHierarchyOutgoingCallsParams, CallHierarchyPrepareParams, CancellationToken, SymbolKind } from 'vscode-languageserver'
import { SomeSemanticType, documentMap, } from './globalSpace'
import {  moduleToDocument, nameArity, sameArity, sameSemanticType, sleep, termTokenRange, tokenRange } from './utils'
import { Term, termRange } from './term'
import { SemanticType } from './analyser'
import { DefMap, DefTerm, Document, RefTerm } from './document'
import { stream } from './stream'
import { findDefTerms, findAtTextDocumentPositionTerm, uriTerm } from './provide-definition'
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
    let {item:{uri,selectionRange:{start:position}}} = params;
    let res = await findAtTextDocumentPositionTerm({textDocument:{uri},position});
    if(!res) return [];
    let term = res.term as DefTerm
    if (term.semanticType == "module"){
        return findModuleOutgoingCalls(res)
    }
    return findDefTerms(uriTerm.create(uri,term))
        .map(x=>(x.term as DefTerm).clause.calledNodes)
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
    return  stream(documentMap.values())
    .map(doc =>{
        let uri = doc.uri
        return stream(doc.refMap.get(term.name)).map(x=>({uri,term:x}))
    })
    .flat()
    .map(uriTermToCallHierarchyIncomingItem).toArray()
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
function findRefTermInDocument(semanticType:SomeSemanticType,term:Term,document:Document){
    let uri = document.uri
    let terms = document.defMap[semanticType].get(term.name);
    let refterms = stream(terms)
    .filter(x=>sameArity(x,term))
    .map(x=>x.clause.calledNodes)
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
        uri,
        range:termRange(term),
        selectionRange:termTokenRange(term)
    }
}

function uriTermToCallHierarchyIncomingItem(params: uriTerm):CallHierarchyIncomingCall {
    let {term,uri} = params;
    return {
        from:uriTermToCallHierarchyItem({uri ,term:term.clause!.calleeNode!}),
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
    let document = moduleToDocument(term.name)!;
    return stream(document.importModules.values())
        .concat(document.includeModules.values())
        .map(x=>uriTermToCallHierarchyOutgoingCall({uri,term:x}))
        .nonNullable().toArray()
}

function findModuleIncmoingCalls(uriTerm: { uri: string; term: Term }) {
    let {uri,term} = uriTerm;
    
    return stream(documentMap.values()).map(doc =>{
        let calleeTerm = doc.moduleDefMap.get(term.name);
        if(calleeTerm ){
            return {
                from:uriTermToCallHierarchyItem({uri: doc.uri, term:calleeTerm}),
                fromRanges:[stream(doc.refMap.get(term.name)).map(termTokenRange).head()!]
            }
        }
    }).nonNullable().toArray()
}

