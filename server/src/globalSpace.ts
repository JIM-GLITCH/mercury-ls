import type{ Document } from './document'
import { MultiMapSet } from './multimap_set'




export let docsMap = new Map<string,Document>();

export let moduleUriMap:Map<string,string> = new Map()
export let funcMap = new MultiMapSet<string,Document>();
export let predMap = new MultiMapSet<string,Document>();
export let typeMap = new MultiMapSet<string,Document>();
// export let definitionsMap = new MultiMapSet<string,Document>();
// export let referencesMap = new MultiMapSet<string,Document>();
// export let typesMap = new MultiMapSet<string,Document>();