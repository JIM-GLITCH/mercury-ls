import { Location, ReferenceParams } from 'vscode-languageserver'
import { docsMap, refMap } from './globalSpace'
import { sleep } from './utils'
import { Term, termRange } from './term'

export async function ReferenceProvider(params:ReferenceParams) {
    let uri  = params.textDocument.uri;
    let pos = params.position
    let document ;
    while( !(document = docsMap.get(uri))){
        await sleep(100);
    }
    let term = document.search(pos);

    if(!term) return [];
    switch (term.semanticType) {
        case 'variable':{
            // 查找 variable的引用 只需要在这个varaible在的clause范围里查找
            let refs:Location[] = [];
            for( const refTerm of term.clause!.varmap.get(term.name)){
                refs.push({uri,range:termRange(refTerm)});
            }
            return refs;
        }
        case 'func':{
            let refs = findReferences(term);
            return refs;
        }
        case 'pred':{
            let refs = findReferences(term);
            return refs;
        }
        case 'type':
        case 'module':
            break
        default:
            let refs = findReferences(term);
            return refs;
    }
    return [];
}
function findReferences(term:Term){
    let refs =[]
    for (const doc of refMap.get(term.name)) {
        for (const refTerm of doc.refMap.get(term.name)) {
            refs.push({uri:doc.uri,range:termRange(refTerm)})
        }
    }
    return refs;
}