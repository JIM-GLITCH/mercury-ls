import { DeclarationParams, Location } from 'vscode-languageserver'
import {  sameArity, sameSemanticType, sleep, termTokenRange } from './utils'
import { Term, termRange } from './term'
import { stream } from './stream'
import { findAtTextDocumentPositionTerm, uriTerm } from './provide-definition'
import { URI } from 'vscode-uri'
import type { MercuryServices } from './services'

export async function DeclarationProvider(services: MercuryServices, params:DeclarationParams) {
    let uriTerm = await findAtTextDocumentPositionTerm(services, params)
    if(!uriTerm)
        return 
    let term = uriTerm.term
    let semanticType = term.semanticType;
    
    if(semanticType == "variable"){
        return ;
    }
    
    if(semanticType=="module"){
        let doc = services.index.getModuleDoc(term);
        if(!doc)
            return []
        let defTerm = services.index.get(doc)!.module!
        return [uriTermToLocation({uri:doc.uri,term:defTerm})]

    }
    /* 如果有module属性 在 module里查找 */
    if(term.qualified){
        let doc  =  services.index.getModuleDoc(term.qualified)
        if(!doc)
            return [];
        let uri = doc.uri
        let candidates  =  services.index.get(doc)?.exports.get(term.name)
        if(candidates){
            let res = stream(candidates).filter(x=>sameArity(x,term))
            .map(term=>uriTermToLocation({uri,term})).toArray()
            return res
        }
    }
    /* 在本文件查找 */
    let uri = uriTerm.uri;
    let doc  = services.documents.getOrCreateDocument(uri);
    let candidates = services.index.get(doc)!.declaration.get(term.name);
    let res = stream(candidates)
        .filter(x=>sameArity(x,term))
        .map(term=>uriTermToLocation({uri,term}))
        .toArray()
    if(res.length>0)
        return res

    /**如果本文件没查找到 在导入的文件里找 */
    // res = stream(services.index.get(doc)!.imports)
    //     .map(x=>services.index.getModuleDoc(x))
    //     .nonNullable()
    //     .map(targetDoc=>services.index.get(targetDoc)?.exports)
    //     .nonNullable()
    //     .map(map=>{
    //         map.get()
    //     })
}

function uriTermToLocation(uriTerm: uriTerm) {
    let {uri,term} = uriTerm;
    return Location.create(
        uri.toString(),
        termTokenRange(term)
    )
}
