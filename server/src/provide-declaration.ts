import { DeclarationParams, Location } from 'vscode-languageserver'
import { SomeSemanticType, docsMap, funcMap, predMap } from './globalSpace'
import {  sleep } from './utils'
import { Term, termRange } from './term'

export async function DeclarationProvider(params:DeclarationParams) {
    let pos = params.position;
    let uri = params.textDocument.uri;
    let document;
    while(!(document=docsMap.get(uri))){
        await sleep(100);
    }
    let term = document.search(pos);
    if(!term) return
    switch (term.semanticType!) {
        case 'variable':{
            return;
        }
        case 'func':{
            let collect = findDeclarations('func',term);
            return collect
        }
        case 'pred':{
            let collect = findDeclarations('pred',term);
            return collect
        }
        case 'type':
        case 'module':
            
            break;
    
        default:{
            
        }

            break;
    }
}
function findDeclarations(SemanticType:SomeSemanticType,term:Term){
    let collect:Location[]=[];
    for (const doc of funcMap.get(term.name)) {
        // // 如果没有导入 跳过
        // if (!document.importModules.has(doc.fileNameWithoutExt)){
        //     continue
        // }
        //如果导入 进行查找
        let funcTerms = doc.declMap[SemanticType].get(term.name);
        for (const funcTerm of funcTerms) {
            if(funcTerm.arity!=term.arity) continue;
            collect.push({
                uri:doc.uri,
                range:termRange(funcTerm)
            })
        }
    }
    return collect
}