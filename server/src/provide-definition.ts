import { DefinitionParams, Location } from 'vscode-languageserver'
import { SomeSemanticType, docsMap, funcMap, globalMap, moduleMap, predMap } from './globalSpace'
import { sleep, termTokenRange } from './utils'
import { Term, termRange } from './term'
import { Document } from './document'

export async function DefinitionProvider(params:DefinitionParams):Promise<Location[]> {
    let pos = params.position;
    let uri = params.textDocument.uri;
    let document ;
    while( !(document = docsMap.get(uri))){
        await sleep(100);
    }

    let term =document.search(pos);
    if(!term) return [];
    switch (term.semanticType!) {
        case 'variable':{
            // 在 variable所在的clause里查找
            let node = term.clause!.varmap.get(term.name)[0];
            if(!node) return [];
            return [{
                uri,
                range:termRange(node)
            }] as Location[];
        }
        case 'func':{
            let defs=findDefinitions('func',term,document);
            return defs
        }
        case 'pred':{
            let defs=findDefinitions('pred',term,document);
            return defs
        }
        case 'type':
        case 'module':{
            let document = moduleMap.get(term.name);
            if(!document) return [];
            let moduleDefTerm = document.moduleDefMap.get(term.name)
            if(!moduleDefTerm) return [];
            return [{
                uri:document.uri,
                range:termRange(moduleDefTerm)
            }]
        }
        default:{
            // 查找所有map
            let defs1=findDefinitions('func',term,document);
            
            let defs2=findDefinitions('pred',term,document);
            defs1.push(...defs2);
            return defs1
        }
    }
}

function findDefinitions(semanticType:SomeSemanticType,term:Term,document:Document){
    let defs:Location[]=[];
    // term有module属性 在该module里找
    // if(term.module){
    //     let doc = getDocumentFromModule(term.module);
    //     if(!doc) return defs;
    //     let funcTerms = doc.defMap[semanticType].get(term.name);
    //     for (const funcTerm of funcTerms) {
    //         defs.push({
    //             uri:doc.uri,
    //             range:termRange(funcTerm)
    //         })
    //     }
    //     return defs;
    // }
    // 在本文件查找
    findDefinitionInThisDocument(semanticType,term,document,defs)
    // 在其他文件里查找
    findDefinitionInOtherDocument(semanticType,term,document,defs)
    return defs
}

function findDefinitionInThisDocument(semanticType: SomeSemanticType, term: Term, document: Document,defs:Location[]) {
    let funcTerms = document.defMap[semanticType].get(term.name);
    for (const funcTerm of funcTerms) {
        if(funcTerm.arity != term.arity) continue;
        defs.push({
            uri:document.uri,
            range:termTokenRange(funcTerm)
        })
    }
}
function findDefinitionInOtherDocument(semanticType: SomeSemanticType, term: Term, document: Document,defs:Location[]){
    for (const doc of globalMap[semanticType].get(term.name)) {
        // 如果没有导入 跳过
        // if (!document.importModules.has(doc.fileNameWithoutExt)){
        //     continue
        // }
        // 跳过本文件
        if(doc == document) continue;
        //如果导入 进行查找
        findDefinitionInThisDocument(semanticType,term,document,defs);
    }
}