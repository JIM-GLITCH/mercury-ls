import { DefinitionParams, Location, TextDocumentPositionParams } from 'vscode-languageserver'
import { SomeSemanticType, docsMap as uriToDocumentMap, funcMap, globalMap, moduleMap, predMap } from './globalSpace'
import { sleep, termTokenRange } from './utils'
import { Term, termRange } from './term'
import { DefTerm, Document } from './document'
import { EMPTY_STREAM, Stream, stream } from './stream'

export async function DefinitionProvider(params:DefinitionParams):Promise<Location[]> {
    // 先找到指定位置的term 
    let termAndUri = await findAtTextDocumentPositionTerm(params);
    if(!termAndUri) return []
    return findDefTerms(termAndUri)
        .map(uriTermToLocation).toArray()
}

function findDefinitionTermWithoutSamantic(term:Term,document:Document){
    let defterm1 =findDefinitionTerm('func',term,document)
    let defterm2 = findDefinitionTerm('pred',term,document)
    return defterm1.concat(defterm2)
}
function findDefinitionTerm(semanticType:SomeSemanticType,term:Term,document:Document){
    // term有module属性 在该module里找
    if(term.module){
        let doc = moduleMap.get(term.module)
        if(!doc) return stream([]);
        let res = findDefTermInThisDocument(semanticType,term,doc)
        return res
    }
    // 在本文件查找
    let defs1 = findDefTermInThisDocument(semanticType,term,document)
    // 在其他文件里查找
    let defs2 = findDefTermInOtherDocument(semanticType,term,document)
    let res = defs1.concat(defs2);
    return res;
}

function findDefTermInThisDocument(semanticType: SomeSemanticType, term: Term, document: Document) {
    let uri = document.uri;
    let res = stream(document.defMap[semanticType].get(term.name))
        .map(term=>({uri,term}))
    return res;

}
function findDefTermInOtherDocument(semanticType: SomeSemanticType, term: Term, document: Document){
    let importModules = document.importModules;
    let res = stream(importModules.keys())
    .map(x=>moduleMap.get(x))
    .nonNullable()
    .flatMap(doc=>findDefTermInThisDocument(semanticType,term,doc))
    return res;
}

type UriAndTerm={
    uri:string,
    term:Term
}

function uriTermToLocation(uriTerm:UriAndTerm){
    return {
        uri:uriTerm.uri,
        range:termTokenRange(uriTerm.term)
    }
}

export  function findDefTerms(params:UriAndTerm) {
    let {term,uri} = params;
    let document  = uriToDocumentMap.get(uri)!;
    switch (term.semanticType!) {
        case 'variable':{
            // 在 variable所在的clause里查找
            let node = term.clause!.varmap.get(term.name)[0];
            if(!node) return stream([]);
            return stream([{
                uri,
                term:node
            }]);
        }
        case 'func':{
            let defs=findDefinitionTerm('func',term,document)
            return defs
        }
        case 'pred':{
            let defs=findDefinitionTerm('pred',term,document)
            return defs
        }
        case 'type':
            return stream([]);
        case 'module':{
            let document = moduleMap.get(term.name);
            if(!document) return stream([]);
            let moduleDefTerm = document.moduleDefMap.get(term.name)
            if(!moduleDefTerm) return stream([]);
            return stream([{
                uri:document.uri,
                term:moduleDefTerm
            }])
        }
        default:{
            // 查找所有map
            let defs =findDefinitionTermWithoutSamantic(term,document)
            return defs
        }
    }
}
export async function findAtTextDocumentPositionTerm(params: TextDocumentPositionParams){
    let pos = params.position;
    let uri = params.textDocument.uri;
    while( !uriToDocumentMap.get(uri)){
        await sleep(100);
    }
    let document = uriToDocumentMap.get(uri)!
    let term =  document.search(pos);
    if (term) return{
        uri ,
        term
    }

}