import { MercuryDocument } from './document-manager'
// import { moduleMap } from './globalSpace'
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

/**
 * 全局导出符号索引：各模块 `:- interface.` 段声明的符号（visitor 的 exports，
 * term.qualified 指向所属模块）。供 linker 按名字直接取候选，免去逐个
 * import 模块查询。文档重建/删除时需同步 set/delete。
 */
class ExportManager {
    exportMap = new MultiMap<string, Term>()
    private byDoc = new Map<MercuryDocument, Term[]>()
    set(doc: MercuryDocument) {
        this.delete(doc)
        const vr = doc.visitResult
        if (!vr) return
        const terms: Term[] = []
        vr.exports.forEach(t => terms.push(t))
        this.byDoc.set(doc, terms)
        for (const t of terms) this.exportMap.add(t.name, t)
    }
    delete(doc: MercuryDocument) {
        const old = this.byDoc.get(doc)
        if (!old) return
        for (const t of old) this.exportMap.delete(t.name, t)
        this.byDoc.delete(doc)
    }
    get(name: string): readonly Term[] {
        return this.exportMap.get(name)
    }
}
export let exportManager = new ExportManager()