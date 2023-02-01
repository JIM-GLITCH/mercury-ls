import { Location, ReferenceParams } from 'vscode-languageserver'
import { docsMap, refMap } from './globalSpace'
import { sleep } from './utils'
import { termRange } from './term'

export async function ReferenceProvider(params:ReferenceParams) {
    let uri  = params.textDocument.uri;
    let pos = params.position
    let document ;
    while( !(document = docsMap.get(uri))){
        await sleep(100);
    }
    let term = document.search(pos);

    if(!term) return undefined;
    let refs :Location[]=[];
    switch (term.semanticType) {
        case 'variable':{
            // 查找 variable的引用 只需要在这个varaible在的clause范围里查找
            for( const refTerm of term.clause!.varmap.get(term.name)){
                refs.push({uri,range:termRange(refTerm)});
              }
              return refs;
        }
        case 'func':{
            for (const doc of refMap.get(term.name)) {
                for (const refTerm of doc.refMap.get(term.name)) {
                    refs.push({uri:doc.uri,range:termRange(refTerm)})
                }
            }
            return refs;
        }
        case 'pred':{
            for (const doc of refMap.get(term.name)) {
                for (const refTerm of doc.refMap.get(term.name)) {
                    refs.push({uri:doc.uri,range:termRange(refTerm)})
                }
            }
            return refs;
        }
        case 'type':
        case 'module':
        default:
            break;
    }
    return refs;
}