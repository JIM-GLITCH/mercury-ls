import { DefinitionParams, Location } from 'vscode-languageserver'
import { docsMap, funcMap, moduleUriMap, predMap } from './globalSpace'
import { getDocumentFromModule, sleep } from './utils'
import { termRange } from './term'
import { Document } from './document'

export async function DefinitionProvider(params:DefinitionParams) {
    let pos = params.position;
    let uri = params.textDocument.uri;
    let document ;
    while( !(document = docsMap.get(uri))){
        await sleep(100);
    }

    let term =document.search(pos);
    if(!term) return undefined;
    switch (term.semanticType!) {
        case 'variable':{
            // 在 variable所在的clause里查找
            let node = term.clause!.varmap.get(term.name)[0];
            if(!node) return undefined;
            return {
                uri,
                range:termRange(node)
            } as Location;
        }
        case 'func':{
            let defs:Location[]=[];
            // term有module属性 在该module里找
            if(term.module){
                let doc = getDocumentFromModule(term.module);
                if(!doc) return;
                let funcTerms = doc.funcDefMap.get(term.name);
                for (const funcTerm of funcTerms) {
                    defs.push({
                        uri:uri,
                        range:termRange(funcTerm)
                    })
                }
                return defs;
            }
            // 在本文件查找
            let funcTerms = document.funcDefMap.get(term.name);
            for (const funcTerm of funcTerms) {
                defs.push({
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
                let funcTerms = doc.funcDefMap.get(term.name);
                for (const funcTerm of funcTerms) {
                    defs.push({
                        uri:uri,
                        range:termRange(funcTerm)
                    })
                }
            }
            return defs
        }
        case 'pred':{
            let defs:Location[]=[];
            // term有module属性 在该module里找
            if(term.module){
                let doc = getDocumentFromModule(term.module);
                if(!doc) return;
                let predTerms = doc.predDefMap.get(term.name);
                for (const predTerm of predTerms) {
                    defs.push({
                        uri:uri,
                        range:termRange(predTerm)
                    })
                }
                return defs;
            }
            // 在本文件查找
            let predTerms = document.predDefMap.get(term.name);
            for (const predTerm of predTerms) {
                defs.push({
                    uri:uri,
                    range:termRange(predTerm)
                })
            }
            // 在全局的文件里查找
            for (const doc of predMap.get(term.name)) {
                // 如果没有导入 跳过
                if (!document.importModules.has(doc.fileNameWithoutExt)){
                    continue
                }
                //如果导入 进行查找
                let predTerms = doc.predDefMap.get(term.name);
                for (const predTerm of predTerms) {
                    defs.push({
                        uri:uri,
                        range:termRange(predTerm)
                    })
                }
            }
            return defs;
        }
        case 'type':
        case 'module':
        default:
            // 查找所有map

    }

}

