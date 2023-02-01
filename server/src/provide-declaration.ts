import { DeclarationParams, Location } from 'vscode-languageserver'
import { docsMap, funcMap, predMap } from './globalSpace'
import { getDocumentFromModule, sleep } from './utils'
import { termRange } from './term'

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
            let collect:Location[]=[];
            // term有module属性 在该module里找
            if(term.module){
                let doc = getDocumentFromModule(term.module);
                if(!doc) return;
                let funcTerms = doc.funcDeclMap.get(term.name);
                for (const funcTerm of funcTerms) {
                    collect.push({
                        uri:uri,
                        range:termRange(funcTerm)
                    })
                }
                return collect;
            }
            // 在本文件查找
            let funcTerms = document.funcDeclMap.get(term.name);
            for (const funcTerm of funcTerms) {
                collect.push({
                    uri:uri,
                    range:termRange(funcTerm)
                })
            }
            // 在全局的文件里查找
            for (const doc of funcMap.get(term.name)) {
                // 如果没有导入 跳过
                if (!document.importModules.has(doc.fileNameWithoutExt)){
                    continue
                }
                //如果导入 进行查找
                let funcTerms = doc.funcDeclMap.get(term.name);
                for (const funcTerm of funcTerms) {
                    collect.push({
                        uri:uri,
                        range:termRange(funcTerm)
                    })
                }
            }
            return collect
        }
        case 'pred':{
            let collect:Location[]=[];
            // term有module属性 在该module里找
            if(term.module){
                let doc = getDocumentFromModule(term.module);
                if(!doc) return;
                let terms = doc.predDeclMap.get(term.name);
                for (const term of terms) {
                    collect.push({
                        uri:uri,
                        range:termRange(term)
                    })
                }
                return collect;
            }
            // 在本文件查找
            let terms = document.predDeclMap.get(term.name);
            for (const term of terms) {
                collect.push({
                    uri:uri,
                    range:termRange(term)
                })
            }
            // 在全局的文件里查找
            for (const doc of predMap.get(term.name)) {
                // 如果没有导入 跳过
                if (!document.importModules.has(doc.fileNameWithoutExt)){
                    continue
                }
                //如果导入 进行查找
                let terms = doc.predDeclMap.get(term.name);
                for (const term of terms) {
                    collect.push({
                        uri:uri,
                        range:termRange(term)
                    })
                }
            }
            return collect
        }
        case 'type':
        case 'module':
            
            break;
    
        default:
            break;
    }
}