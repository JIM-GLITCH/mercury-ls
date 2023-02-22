import { DeclarationParams, Location } from 'vscode-languageserver'
import { SomeSemanticType, documentMap, moduleToDocument } from './globalSpace'
import {  sameArity, sameSemanticType, sleep, termTokenRange } from './utils'
import { Term, termRange } from './term'
import { stream } from './stream'
import { DefinitionProvider, findAtTextDocumentPositionTerm } from './provide-definition'

export async function DeclarationProvider(params:DeclarationParams) {
    let uriTerm = await findAtTextDocumentPositionTerm(params)
    if(!uriTerm)
        return 
    let term = uriTerm.term
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
    /* 如果有module属性 在 module里查找 */
    if(term.module){
        let doc  =  moduleToDocument(term.module)
        if(!doc)
            return [];
        let uri = doc.uri
        return stream(Object.values(doc.declarationMap))
        .map(x=>x.get(term.name)).flat()
        .filter(x=>sameArity(x,term!))
        .map(term=>uriTermToLocation({uri,term}))
        .toArray()
    }
    /* 在本文件查找 */
    let uri = uriTerm.uri;
    let doc  = documentMap.get(uri)!;
    let res =  stream(Object.values(doc.declarationMap))
        .map(x=>x.get(term.name)).flat()
        .filter(x=>sameArity(x,term!))
        .map(term=>uriTermToLocation({uri,term}))
        .toArray()

    if(res.length>0)
        return res

    /**如果本文件没查找到 在导入的文件里找 */
    // TODO
}

function uriTermToLocation(uriTerm: { uri: string; term: Term}) {
    let {uri,term} = uriTerm;
    return Location.create(
        uri,
        termTokenRange(term)
    )
}
