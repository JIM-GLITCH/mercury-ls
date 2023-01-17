import { Document } from './document'
import { MultiMapSet } from './multimap_set'

export let indexMap = new MultiMapSet<string,Document>();
export function link(doc:Document) {
    for (const name of doc.exports) {
        indexMap.add(name,doc);
    }
}