import { CallHierarchyIncomingCall, CallHierarchyIncomingCallsParams, CallHierarchyItem, CallHierarchyOutgoingCall, CallHierarchyOutgoingCallsParams, CallHierarchyPrepareParams, SymbolKind } from 'vscode-languageserver'
import { SomeSemanticType, docsMap, funcMap, globalMap, moduleMap, predMap, refMap } from './globalSpace'
import {  nameArity, sameArity, sameSemanticType, sleep, termTokenRange, tokenRange } from './utils'
import { Term, termRange } from './term'
import { SemanticType } from './analyser'
import { DefMap, DefTerm, Document } from './document'
import { stream } from './stream'
import { findDefTerms, findTermAtTextDocumentPosition } from './provide-definition'

export async function prepareCallHierarchyProvider(params:CallHierarchyPrepareParams){
    let res  = await findTermAtTextDocumentPosition(params)
    if(!res) return;
    let res2 = (await findDefTerms(res)).head()
    if(res2){
        return [uriTermToCallHierarchyItem(res2)]
    }
    return [
        uriTermToCallHierarchyItem(res)
    ] as CallHierarchyItem[]

}

export async function outgoingCallsProvider(params:CallHierarchyOutgoingCallsParams){
    let item  = params.item;
    let uri = item.uri;
    let pos = item.selectionRange.start;
    let document  = docsMap.get(uri)
    if(!document) return;
    let term = document.search(pos);
    if(!term) return ;
    switch (term.semanticType!) {
        case 'variable':{
            return
        }
        case 'func':{
            let collect = findOutGoingCalls("func",term,document);
            return collect;
        }
        case 'pred':{
            let collect = findOutGoingCalls("pred",term,document);
            return collect;
        }
        case 'type':
        case 'module':
            break;
        default:
            let collect1 = findOutGoingCalls("func",term,document);
            let collect2 = findOutGoingCalls("pred",term,document);
            collect1.push(...collect2)
            return collect1;
    }

}

export async function incomingCallsProvider(params:CallHierarchyIncomingCallsParams) {
    let item  = params.item;
    let uri = item.uri;
    let pos = item.selectionRange.start;
    let document  = docsMap.get(uri)  
    if(!document) return;
    let term = document.search(pos);
    if(!term) return ;
    let colloct:CallHierarchyIncomingCall[]=[]
    switch (term.semanticType) {
        case 'variable':
            return
        case 'func':{
            for (const doc of refMap.get(term.name)) {
                if(doc!=document && !doc.importModules.has(document.fileNameWithoutExt)){
                    continue;
                }
                for (const refTerm of doc.refMap.get(term.name)) {
                    // refs.push({uri:doc.uri,range:termRange(refTerm)})
                    let calleeTerm = refTerm.clause.calleeNode;
                    colloct.push({
                        from: {
                            name:nameArity(calleeTerm),
                            kind:SemanticTypeToSymbolKind('func'),
                            uri:doc.uri,
                            range:termRange(calleeTerm),
                            selectionRange:tokenRange(calleeTerm.token)
                        },
                        fromRanges:[termRange(refTerm)]
                    })
                }
            }
            return colloct;
        }
        case 'pred':{
            for (const doc of refMap.get(term.name)) {
                for (const refTerm of doc.refMap.get(term.name)) {
                    // refs.push({uri:doc.uri,range:termRange(refTerm)})
                    let calleeTerm = refTerm.clause.calleeNode;
                    colloct.push({
                        from: {
                            name:nameArity(calleeTerm),
                            kind:SemanticTypeToSymbolKind("pred"),
                            uri:doc.uri,
                            range:termRange(calleeTerm),
                            selectionRange:tokenRange(calleeTerm.token)
                        },
                        fromRanges:[termRange(refTerm)]
                    })
                }
            }
            return colloct;
        }
        case 'type':
        case 'module':
            
            break;
    
        default:
            break;
    }
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

function findOutGoingCalls(semanticType:SomeSemanticType,term:Term,document:Document){
    let collect:CallHierarchyOutgoingCall[]=[];
    // term有module属性 在该module里找
    // if(term.module){
    //     let doc = getDocumentFromModule(term.module);
    //     if(!doc) return collect;
    //     let terms = doc.defMap[semanticType].get(term.name);
    //     for (const refNodes of terms.map(x=>x.clause!.calledNodes)) {
    //         for (const refnode of refNodes) {
    //             let refRange = termRange(refnode)
    //             collect.push({
    //                 to: {
    //                     name:refnode.name,
    //                     uri:doc.uri,
    //                     range:refRange,
    //                     kind:SemanticTypeToSymbolKind(refnode.semanticType)??SymbolKind.Function,
    //                     selectionRange:tokenRange(refnode.token)
    //                 },
    //                 fromRanges: [refRange]
    //             })
    //         }
    //     }
    //     return collect;
    // }
    // 在本文件查找
    let terms = document.defMap[semanticType].get(term.name);
    for (const refNodes of terms.filter((x)=>x.arity == term.arity).map(x=>x.clause!.calledNodes)) {
        for (const refnode of refNodes) {
            let refRange = termRange(refnode)
            let kind = refnode.semanticType
                ?   SemanticTypeToSymbolKind(refnode.semanticType)
                :   SymbolKind.Function;
            collect.push({
                to: {
                    name:nameArity(refnode),
                    uri:document.uri,
                    range:refRange,
                    kind,
                    selectionRange:tokenRange(refnode.token)
                },
                fromRanges: [refRange]
            })
        }
    }
    // 在全局的文件里查找
    for (const doc of globalMap[semanticType].get(term.name)) {
        // 如果没有导入 跳过
        // if (!document.importModules.has(doc.fileNameWithoutExt)){
        //     continue
        // }
        // 如果是自己文件 跳过 避免重复
        if( doc  == document ) continue ;
        //如果导入 进行查找
        let terms = doc.defMap[semanticType].get(term.name);
        for (const refNodes of terms.filter((x)=>x.arity == term.arity).map(x=>x.clause!.calledNodes)) {
            for (const refnode of refNodes) {
                let refRange = termTokenRange(refnode)
                let kind = SemanticTypeToSymbolKind(refnode.semanticType);
                collect.push({
                    to: {
                        name:nameArity(refnode),
                        uri:doc.uri,
                        range:refRange,
                        kind,
                        selectionRange:termTokenRange(refnode)
                    },
                    fromRanges: [refRange]
                })
            }
        }
    }
    return collect
}

function findDefinitionTermForCallItem(term: Term, document: Document) {
    // 如果 term 有module属性 到 module文件里查找
    if(term.module){
        let doc = moduleMap.get(term.module);
        if(!doc) return;
        switch (term.semanticType) {
            case 'func':
            case 'pred':{
                let defterms = doc.defMap[term.semanticType].get(term.name)
                    .filter(x => sameArity(x,term));
                let defterm = defterms[0] as Term|undefined
                if(!defterm) return undefined;
                return {
                    term:defterm,
                    uri:doc.uri
                }
            }
            case 'module':{
                let moduleDefTerm = doc.moduleDefMap.get(term.name);
                if(!moduleDefTerm) return undefined;
                return {
                    term:moduleDefTerm,
                    uri:doc.uri
                };
            }
            case 'type':
                return ;
            // case "variable": never happen
            default:
                return undefined
        }
    }
    // 在本文件 和 导入的文件查找
    let defterms = document
}

function findTermAtPosition(params: CallHierarchyPrepareParams): Term | undefined {
    throw new Error('Function not implemented.')
}

function uriTermToCallHierarchyItem(params: { uri: string; term: Term }):CallHierarchyItem {
    let {term,uri} = params;
    return {
        name :nameArity(term),
        kind :SemanticTypeToSymbolKind(term.semanticType),
        uri,
        range:termRange(term),
        selectionRange:termTokenRange(term)
    }
}

