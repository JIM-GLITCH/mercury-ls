import { DeclarationParams, Location } from 'vscode-languageserver'
import { SomeSemanticType, documentMap, moduleToDocument } from './globalSpace'
import {  sameArity, sameSemanticType, sleep, termTokenRange } from './utils'
import { Term, termRange } from './term'
import { stream } from './stream'
import { DefinitionProvider } from './provide-definition'

export async function DeclarationProvider(params:DeclarationParams) {
    let pos = params.position;
    let uri = params.textDocument.uri;
    while(!documentMap.get(uri)){
        await sleep(100);
    }
    let document = documentMap.get(uri)!
    let term = document.search(pos);
    if(!term) 
        return
    let semanticType = term.semanticType;
    
    if(semanticType == "variable"){
        return ;
    }
    
    if(semanticType=="module"){
        let doc = moduleToDocument(term.name);
        if(!doc)
            return []
        let defTerm = doc.moduleDefMap.get(term.name)!
        return [uriTermToLocation({uri:doc.uri,term:defTerm})]

    }
    if(term.module){
        let doc  =  moduleToDocument(term.module)
        if(!doc)
            return [];
        if(semanticType){
            let uri = doc.uri
            return stream(doc.declarationMap[semanticType].get(term.name))
            .filter(x=>sameArity(x,term!)&&sameSemanticType(x,term!))
            .map(term=>uriTermToLocation({uri,term}))
            .toArray()
        }
    }
}

function uriTermToLocation(uriTerm: { uri: string; term: Term}) {
    let {uri,term} = uriTerm;
    return Location.create(
        uri,
        termTokenRange(term)
    )
}
