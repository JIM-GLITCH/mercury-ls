import { CallHierarchyIncomingCall, CallHierarchyIncomingCallsParams, CallHierarchyItem, CallHierarchyOutgoingCall, CallHierarchyOutgoingCallsParams, CallHierarchyPrepareParams, SymbolKind } from 'vscode-languageserver'
import { docsMap, funcMap, predMap, refMap } from './globalSpace'
import { getDocumentFromModule, sleep, tokenRange } from './utils'
import { termRange } from './term'
import { SemanticType } from './analyser'

export async function prepareCallHierarchyProvider(params:CallHierarchyPrepareParams){
    let pos = params.position;
    let uri = params.textDocument.uri;
    let document;
    while(!(document=docsMap.get(uri))){
        await sleep(100);
    }
    let term= document.search(pos);
    if(!term) return;
    if(term.syntaxType=="variable"){
        return 
    }
    return [{
        name:term.name,
        kind:SymbolKind.Function,
        detail:"/"+term.arity,
        uri,
        range:termRange(term),
        selectionRange:tokenRange(term.token)
    }] as CallHierarchyItem[]

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
            let collect:CallHierarchyOutgoingCall[]=[];
            // term有module属性 在该module里找
            if(term.module){
                let doc = getDocumentFromModule(term.module);
                if(!doc) return;
                let terms = doc.funcDefMap.get(term.name);
                for (const refNodes of terms.map(x=>x.clause!.calledNodes)) {
                    for (const refnode of refNodes) {
                        let refRange = termRange(refnode)
                        collect.push({
                            to: {
                                name:refnode.name,
                                uri:doc.uri,
                                range:refRange,
                                kind:SemanticTypeToSymbolKind(refnode.semanticType)??SymbolKind.Function,
                                selectionRange:tokenRange(term.token)
                            },
                            fromRanges: [refRange]
                        })
                    }
                }
                return collect;
            }
            // 在本文件查找
            let terms = document.funcDefMap.get(term.name);
            for (const refNodes of terms.map(x=>x.clause!.calledNodes)) {
                for (const refnode of refNodes) {
                    let refRange = termRange(refnode)
                    collect.push({
                        to: {
                            name:refnode.name,
                            uri:document.uri,
                            range:refRange,
                            kind:SemanticTypeToSymbolKind(refnode.semanticType)??SymbolKind.Function,
                            selectionRange:tokenRange(term.token)
                        },
                        fromRanges: [refRange]
                    })
                }
            }
            // 在全局的文件里查找
            for (const doc of funcMap.get(term.name)) {
                // 如果没有导入 跳过
                if (!document.importModules.has(doc.fileNameWithoutExt)){
                    continue
                }
                //如果导入 进行查找
                let terms = doc.funcDefMap.get(term.name);
                for (const refNodes of terms.map(x=>x.clause!.calledNodes)) {
                    for (const refnode of refNodes) {
                        let refRange = termRange(refnode)
                        collect.push({
                            to: {
                                name:refnode.name,
                                uri:document.uri,
                                range:refRange,
                                kind:SemanticTypeToSymbolKind(refnode.semanticType)??SymbolKind.Function,
                                selectionRange:tokenRange(term.token)
                            },
                            fromRanges: [refRange]
                        })
                    }
                }
            }
            return collect
        }
        case 'pred':{
            let collect:CallHierarchyOutgoingCall[]=[];
            // term有module属性 在该module里找
            if(term.module){
                let doc = getDocumentFromModule(term.module);
                if(!doc) return;
                let terms = doc.funcDefMap.get(term.name);
                for (const refNodes of terms.map(x=>x.clause!.calledNodes)) {
                    for (const refnode of refNodes) {
                        let refRange = termRange(refnode)
                        collect.push({
                            to: {
                                name:refnode.name,
                                uri:doc.uri,
                                range:refRange,
                                kind:SemanticTypeToSymbolKind(refnode.semanticType)??SymbolKind.Function,
                                selectionRange:tokenRange(term.token)
                            },
                            fromRanges: [refRange]
                        })
                    }
                }
                return collect;
            }
            // 在本文件查找
            let terms = document.predDefMap.get(term.name);
            for (const refNodes of terms.map(x=>x.clause!.calledNodes)) {
                for (const refnode of refNodes) {
                    let refRange = termRange(refnode)
                    collect.push({
                        to: {
                            name:refnode.name,
                            uri:document.uri,
                            range:refRange,
                            kind:SemanticTypeToSymbolKind(refnode.semanticType)??SymbolKind.Function,
                            selectionRange:tokenRange(term.token)
                        },
                        fromRanges: [refRange]
                    })
                }
            }
            // 在全局的文件里查找
            for (const doc of predMap.get(term.name)) {
                // 如果没有导入 跳过
                if (!document.importModules.has(doc.fileNameWithoutExt)){
                    continue
                }
                //如果导入 进行查找
                let terms = doc.predDefMap.get(term.name);
                for (const refNodes of terms.map(x=>x.clause!.calledNodes)) {
                    for (const refnode of refNodes) {
                        let refRange = termRange(refnode)
                        collect.push({
                            to: {
                                name:refnode.name,
                                uri:document.uri,
                                range:refRange,
                                kind:SemanticTypeToSymbolKind(refnode.semanticType)??SymbolKind.Function,
                                selectionRange:tokenRange(term.token)
                            },
                            fromRanges: [refRange]
                        })
                    }
                }
            }
            return collect
        }
        case 'type':
        case 'module':
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
                            name:calleeTerm.name,
                            kind:SymbolKind.Function,
                            uri:doc.uri,
                            range:termRange(calleeTerm),
                            selectionRange:tokenRange(calleeTerm.token)
                        },
                        fromRanges:[termRange(calleeTerm)]
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
                            name:calleeTerm.name,
                            kind:SymbolKind.Function,
                            uri:doc.uri,
                            range:termRange(calleeTerm),
                            selectionRange:tokenRange(calleeTerm.token)
                        },
                        fromRanges:[termRange(calleeTerm)]
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

function SemanticTypeToSymbolKind(semanticType: SemanticType | undefined): SymbolKind|undefined {
    if(!semanticType){
        return undefined
    }
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
    }
}

