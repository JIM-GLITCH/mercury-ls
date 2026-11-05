import { MercuryDocument } from './document-manager'
// import { moduleMap } from './globalSpace'
import { MultiMap } from './multimap'
import { Term } from './term'
import { FuncInfo, TypeInfo, keyOf, keyOfTypeCtor } from './document-type'


export class ModuleManager {
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
/** 把模块限定名 Term（可能带 `./2` 链）还原成 `std.array` 这样的点分字符串 */
export function moduleQualifiedName(term: Term): string {
    const parts: string[] = []
    const walk = (t: Term | undefined) => {
        if (!t) return
        if (t.nameArity === './2') {
            walk(t.args[0])
            walk(t.args[1])
            return
        }
        walk(t.qualified)
        parts.push(t.name)
    }
    walk(term)
    return parts.join('.')
}
/**
 * 全局导出符号索引：各模块 `:- interface.` 段声明的符号（visitor 的 exports，
 * term.qualified 指向所属模块）。供 linker 按名字直接取候选，免去逐个
 * import 模块查询。文档重建/删除时需同步 set/delete。
 */
export class ExportManager {
    exportMap = new MultiMap<string, Term>()
    private byDoc = new Map<MercuryDocument, Term[]>()
    // 跨模块类型推断用：类型构造子表 + 函数/谓词签名表
    private typeMap = new Map<string, TypeInfo>()
    private funcMap = new Map<string, FuncInfo>()
    private byDocTypes = new Map<MercuryDocument, { typeKeys: string[]; funcKeys: string[] }>()
    set(doc: MercuryDocument) {
        this.delete(doc)
        const vr = doc.visitResult
        if (!vr) return
        const terms: Term[] = []
        vr.exports.forEach(t => terms.push(t))
        this.byDoc.set(doc, terms)
        for (const t of terms) this.exportMap.add(t.name, t)
        // 结构化签名：供推断跨模块取类型构造子 / 函数签名
        const typeKeys: string[] = []
        for (const ti of vr.types.values()) {
            const k = keyOfTypeCtor(ti.ctor)
            this.typeMap.set(k, ti)
            typeKeys.push(k)
        }
        const funcKeys: string[] = []
        const regFunc = (fi: FuncInfo) => {
            const k = keyOf(fi.name, fi.arity)
            this.funcMap.set(k, fi)
            funcKeys.push(k)
        }
        for (const fi of vr.funcs.values()) regFunc(fi)
        for (const fi of vr.preds.values()) regFunc(fi)
        this.byDocTypes.set(doc, { typeKeys, funcKeys })
    }
    delete(doc: MercuryDocument) {
        const old = this.byDoc.get(doc)
        if (old) {
            for (const t of old) this.exportMap.delete(t.name, t)
            this.byDoc.delete(doc)
        }
        const oldT = this.byDocTypes.get(doc)
        if (oldT) {
            for (const k of oldT.typeKeys) this.typeMap.delete(k)
            for (const k of oldT.funcKeys) this.funcMap.delete(k)
            this.byDocTypes.delete(doc)
        }
    }
    get(name: string): readonly Term[] {
        return this.exportMap.get(name)
    }
    /** 某个模块（点分限定名，如 `std.array`）interface 段导出的全部符号 */
    getByModule(moduleName: string): Term[] {
        const result: Term[] = []
        this.exportMap.forEach(t => {
            if (t.qualified && moduleQualifiedName(t.qualified) === moduleName) result.push(t)
        })
        return result
    }
    // 跨模块推断查询
    lookupType(ctorKey: string): TypeInfo | undefined {
        return this.typeMap.get(ctorKey)
    }
    lookupFunc(name: string, arity: number): FuncInfo | undefined {
        return this.funcMap.get(keyOf(name, arity))
    }
    allTypeInfos(): Iterable<TypeInfo> {
        return this.typeMap.values()
    }
}
