import { Location, ReferenceParams } from 'vscode-languageserver'
import { sleep } from './utils'
import { Term, search, termRange } from './term'
import { mercuryDocuments } from './document-manager'
import { URI } from 'vscode-uri'

export async function ReferenceProvider(params:ReferenceParams) {
    let uri  = params.textDocument.uri;
    let pos = params.position
    let document ;
    while( !(document = mercuryDocuments.getOrCreateDocument(URI.parse(uri)))){
        await sleep(100);
    }
    let term = search(document.parseResult.value,pos);

    if(!term) return [];
    switch (term.semanticType) {
        case 'variable':{
            // 查找 variable的引用 只需要在这个varaible在的clause范围里查找
            let refs:Location[] = [];
            for( const refTerm of term.clause!.varMap.get(term.name)){
                refs.push({uri,range:termRange(refTerm)});
            }
            return refs;
        }
        case 'func':{
            let refs:Location[] = [];
            findReferences(term,refs);
            return refs;
        }
        case 'pred':{
            let refs:Location[] = [];
            findReferences(term,refs);
            return refs;
        }
        case 'type':
            break
        case 'module':{
            let refs:Location[] = [];
            findReferences(term,refs);
            return refs;
        }
        default:
            let refs:Location[] = [];
            findReferences(term,refs);
            return refs;
    }
    return [];
}
function findReferences(term:Term,refs:Location[]){
    for (const doc of mercuryDocuments.all) {
        for (const refTerm of doc.visitResult?.reference.get(term.name)??[]) {
            if(refTerm.arity!=term.arity) continue;
            refs.push({uri:doc.uri.toString(),range:termRange(refTerm)})
        }
    }
}