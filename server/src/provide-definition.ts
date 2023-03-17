import { DefinitionParams, Location, TextDocumentPositionParams } from 'vscode-languageserver'
import { sameArity, sleep, termTokenRange } from './utils'
import { Term, search, termRange } from './term'
import { DefTerm, Document } from './document'
import { EMPTY_STREAM, Stream, stream } from './stream'
import { MercuryDocument, mercuryDocuments } from './document-manager'
import { URI } from 'vscode-uri'
import { moduleManager } from './document-moduleManager'

export async function DefinitionProvider(params:DefinitionParams):Promise<Location[]> {
    // 先找到指定位置的term 
    let termAndUri = await findAtTextDocumentPositionTerm(params);
    if(!termAndUri) return []
    return findDefTerms(termAndUri)
        .map(uriTermToLocation).toArray()
}

// function findDefinitionTermWithoutSamantic(term:Term,document:MercuryDocument){
//     let defterm1 =findDefinitionTerm('func',term,document)
//     let defterm2 = findDefinitionTerm('pred',term,document)
//     return defterm1.concat(defterm2)
// }
function findDefinitionTerm(term:Term,document:MercuryDocument){
    // term qualified
    if(term.qualified){
        let doc =moduleManager.get(term.qualified)
        if(!doc) return stream([]);
        let res = findDefTermInThisDocument(term,doc)
        return res
    }
    // 在本文件查找 如果找到就返回
    let defs1 = findDefTermInThisDocument(term,document)
    if (!defs1.isEmpty())
        return defs1;
    // 在本文件没找到 在其他文件里查找
    let defs2 = findDefTermInOtherDocument(term,document)
    return defs2;
}

function findDefTermInThisDocument( term: Term, document: MercuryDocument){
    let uri = document.uri;
    let definition =document.visitResult?.definition
    if(!definition)
        return stream([])
    let res = stream(definition.get(term.name))
        .filter(x=>sameArity(x,term))
        .map(term=>(uriTerm.create(uri,term)))
    return res;

}
function findDefTermInOtherDocument(term: Term, document: MercuryDocument){
    let imports = document.visitResult?.imports;
    if(!imports){
        return stream([])
    }
    
    let res = stream(imports)
    .map(x => moduleManager.get(x))
    .nonNullable()
    .flatMap(doc=>findDefTermInThisDocument(term,doc))
    
    return res;
}

export interface uriTerm{
    uri:URI,
    term:Term
}
export namespace uriTerm{
    export function create(uri:URI,term:Term):uriTerm{
        return{
            uri,term
        }
    }
}
export function uriTermToLocation(uriTerm:uriTerm){
    return Location.create(
        uriTerm.uri.toString(),
        termTokenRange(uriTerm.term)
    )
}

export  function findDefTerms(params:uriTerm):Stream<uriTerm> {
    let {term,uri} = params;
    let document  = mercuryDocuments.getOrCreateDocument(uri)!;
    switch (term.semanticType!) {
        case 'variable':{
            // 在 variable所在的clause里查找
            let node = term.clause!.varMap.get(term.name)[0];
            if(!node) return stream([]);
            return stream([{
                uri,
                term:node
            }]);
        }
        case 'func':
        case 'pred':
        case 'type':{
            return findDefinitionTerm(term,document);

        }
            
        case 'module':{
            let document = moduleManager.get(term);
            if(!document) 
                return stream([]);
            let module = document.visitResult?.module
            if(!module) 
                return stream([]);
            let uri = document.uri ;
            return stream([{
                uri,
                term:module
            }])
        }
        default:{
            return stream([])
            // // 查找所有map
            // let defs =findDefinitionTermWithoutSamantic(term,document)
            // return defs
        }
    }
}

export async function findAtTextDocumentPositionTerm(params: TextDocumentPositionParams){
    let pos = params.position;
    let uri = URI.parse(params.textDocument.uri);
    while( !mercuryDocuments.getOrCreateDocument(uri)){
        await sleep(100);
    }
    let document = mercuryDocuments.getOrCreateDocument(uri)!
    let rootNode =  document.parseResult.value 
    let term = search(rootNode,pos);
    if (term) return{
        uri ,
        term
    }
}