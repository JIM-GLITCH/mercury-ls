import { Location, ReferenceParams } from 'vscode-languageserver'
import { documentMap } from './globalSpace'
import { sleep } from './utils'
import { Term, termRange } from './term'

export async function ReferenceProvider(params:ReferenceParams) {
    let uri  = params.textDocument.uri;
    let pos = params.position
    let document ;
    while( !(document = documentMap.get(uri))){
        await sleep(100);
    }
    let term = document.search(pos);

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
    for (const doc of documentMap.values()) {
        for (const refTerm of doc.refMap.get(term.name)) {
            if(refTerm.arity!=term.arity) continue;
            refs.push({uri:doc.uri,range:termRange(refTerm)})
        }
    }
}