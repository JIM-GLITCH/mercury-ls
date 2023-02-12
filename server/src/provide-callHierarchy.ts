import { CallHierarchyIncomingCall, CallHierarchyIncomingCallsParams, CallHierarchyItem, CallHierarchyOutgoingCall, CallHierarchyOutgoingCallsParams, CallHierarchyPrepareParams, SymbolKind } from 'vscode-languageserver'
import { SomeSemanticType, docsMap, funcMap, globalMap, moduleMap, predMap, refMap } from './globalSpace'
import {  moduleToDocument, nameArity, sameArity, sameSemanticType, sleep, termTokenRange, tokenRange } from './utils'
import { Term, termRange } from './term'
import { SemanticType } from './analyser'
import { DefMap, DefTerm, Document, RefTerm } from './document'
import { stream } from './stream'
import { findDefTerms, findAtTextDocumentPositionTerm } from './provide-definition'
/**
 * find definition term as the callheirarchyItem
 * @param params 
 * @returns 
 */
export async function prepareCallHierarchyProvider(params:CallHierarchyPrepareParams){
    let res  = await findAtTextDocumentPositionTerm(params)
    if(!res) return;
    let res2 = findDefinitionTerm(res)
    if(res2){
        return [uriTermToCallHierarchyItem(res2)]
    }
}


function findDefinitionTerm(uriTerm:uriTerm){
    return findDefTerms(uriTerm).head()
}


export async function outgoingCallsProvider(params:CallHierarchyOutgoingCallsParams):Promise<CallHierarchyOutgoingCall[]>{
    let {item:{uri,selectionRange:{start:position}}} = params;
    let res = await findAtTextDocumentPositionTerm({textDocument:{uri},position});
    if(!res) return [];
    let term = res.term
    if (term.semanticType == "module"){
        return findModuleOutgoingCalls(res)
    }
    if(term.clause?.calleeNode != term)
        return [];
    let calledNodes = term.clause.calledNodes;
    return stream(calledNodes).map(x=>uriTermToCallHierarchyOutgoingCall({uri,term:x})).nonNullable().toArray()

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
    return  stream(refMap.get(term.name))
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


interface uriTerm {
    uri:string,
    term:Term
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
        from:uriTermToCallHierarchyItem({uri ,term:term.clause!.calleeNode}),
        fromRanges:[termTokenRange(term)]
    }
}

function uriTermToCallHierarchyOutgoingCall(uriTerm: uriTerm):CallHierarchyOutgoingCall|undefined{
    let toTerm = findDefinitionTerm(uriTerm)
    if(!toTerm) return undefined;
    let to = uriTermToCallHierarchyItem(toTerm)
    return {
        to,
        fromRanges:[termTokenRange(uriTerm.term)]
    }
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
    
    return stream(refMap.get(term.name)).map(doc =>{
        let calleeTerm :Term|undefined= doc.moduleDefMap.values().next().value;
        let uri = doc.uri
        if(calleeTerm ){
            return {
                from:uriTermToCallHierarchyItem({uri,term:calleeTerm}),
                fromRanges:[stream(doc.refMap.get(term.name)).map(termTokenRange).head()!]
            }
        }
    }).nonNullable().toArray()

}

