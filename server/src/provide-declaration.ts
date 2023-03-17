import { DeclarationParams, Location } from 'vscode-languageserver'
import {  sameArity, sameSemanticType, sleep, termTokenRange } from './utils'
import { Term, termRange } from './term'
import { stream } from './stream'
import { DefinitionProvider, findAtTextDocumentPositionTerm, uriTerm } from './provide-definition'
import { moduleManager } from './document-moduleManager'
import { mercuryDocuments } from './document-manager'
import { URI } from 'vscode-uri'

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
        let doc = moduleManager.get(term);
        if(!doc)
            return []
        let defTerm = doc.visitResult!.module!
        return [uriTermToLocation({uri:doc.uri,term:defTerm})]

    }
    /* 如果有module属性 在 module里查找 */
    if(term.qualified){
        let doc  =  moduleManager.get(term.qualified)
        if(!doc)
            return [];
        let uri = doc.uri
        let candidates  =  doc.visitResult?.exports.get(term.name)
        if(candidates){
            let res = stream(candidates).filter(x=>sameArity(x,term))
            .map(term=>uriTermToLocation({uri,term})).toArray()
            return res
        }
    }
    /* 在本文件查找 */
    let uri = uriTerm.uri;
    let doc  = mercuryDocuments.getOrCreateDocument(uri);
    let candidates = doc.visitResult!.declaration.get(term.name);
    let res = stream(candidates)
        .filter(x=>sameArity(x,term))
        .map(term=>uriTermToLocation({uri,term}))
        .toArray()
    if(res.length>0)
        return res

    /**如果本文件没查找到 在导入的文件里找 */
    // res = stream(doc.visitResult!.imports)
    //     .map(x=>moduleManager.get(x))
    //     .nonNullable()
    //     .map(targetDoc=>targetDoc.visitResult?.exports)
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
