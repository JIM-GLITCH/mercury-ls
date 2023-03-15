import type{ Document, ModuleTerm } from './document'
import { MultiMapSet } from './multimap_set'

export type SomeSemanticType = 
    "func"|
    "pred"|
    "type"


export let documentMap = new Map<string,Document>();
export let moduleMap = new Map<string,Document>(); 
// export let funcMap = new MultiMapSet<string,Document>();
// export let predMap = new MultiMapSet<string,Document>();
// export let typeMap = new MultiMapSet<string,Document>();
// // export let definitionsMap = new MultiMapSet<string,Document>();
// export let refMap = new MultiMapSet<string,Document>();
// // export let typesMap = new MultiMapSet<string,Document>();
// export let globalMap = {
//     "func":funcMap,
//     "pred":predMap,
//     "type":typeMap,
// }
