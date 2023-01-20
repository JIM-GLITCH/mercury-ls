import { Document } from './document'
import { MultiMapSet } from './multimap_set'
import { docsMap } from './server'

export let declarationsMap = new MultiMapSet<string,Document>();
export let definitionsMap = new MultiMapSet<string,Document>();
export let referencesMap = new MultiMapSet<string,Document>();
export let typesMap = new MultiMapSet<string,Document>();
export function link(doc:Document) {
    // 首先去掉旧的索引
    let uri  =doc.uri;
    let oldDoc = docsMap.get(uri);
    if(oldDoc){
        for (const name_arity of oldDoc.declsMap.map.keys()) {
            declarationsMap.delete(name_arity,oldDoc);
        }
        for (const name_arity of oldDoc.defsMap.map.keys()) {
            definitionsMap.delete(name_arity,oldDoc);
        }  
        for (const name_arity of oldDoc.refsMap.map.keys()) {
            referencesMap.delete(name_arity,oldDoc);
        }
        
    }
    // 然后添加新的索引
    for (const name_arity of doc.declsMap.map.keys()) {
        declarationsMap.add(name_arity,doc);
    }
    for (const name_arity of doc.defsMap.map.keys()) {
        definitionsMap.add(name_arity,doc);
    }  
    for (const name_arity of doc.refsMap.map.keys()) {
        referencesMap.add(name_arity,doc);
    }
}