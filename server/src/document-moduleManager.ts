import { MercuryDocument } from './documents'
import { moduleMap } from './globalSpace'
import { MultiMap } from './multimap'
import { Term } from './term'


class ModuleManager {
    moduleMap = new MultiMap<string,MercuryDocument>
    get(term:Term){
        let candidates = this.moduleMap.get(term.name)
        for (const candidate of candidates) {
            let targetTerm = candidate.visitResult!.module!;
            if(equalQualified(term,targetTerm)){
                return candidate
            }
        }
    }
    set(term:Term,doc:MercuryDocument){
        this.moduleMap.add(term.name,doc);
    }
    delete(doc:MercuryDocument){
        let term = doc.visitResult!.module!
        this.moduleMap.delete(term.name,doc)
    }
}

export function equalQualified(term: Term, targetTerm: Term):boolean {
    if(term.name != targetTerm.name){
        return false
    }
    if(targetTerm.qualified && term.qualified){
        return equalQualified(targetTerm.qualified,term.qualified)
    }
    return true
}
export let moduleManager =  new ModuleManager()