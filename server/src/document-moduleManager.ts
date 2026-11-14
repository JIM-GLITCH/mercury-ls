import { MercuryDocument } from './document-manager'
// import { moduleMap } from './globalSpace'
import { MultiMap } from './multimap'
import { Term } from './term'
import { FuncInfo, TypeCtor, TypeInfo, keyOf, keyOfTypeCtor } from './document-type'


export class ModuleManager {
    moduleMap = new MultiMap<string,MercuryDocument>
    // doc → 其 module 项：invalidate 后 visitResult 被清空，delete 时无法再从
    // visitResult 反查模块名，必须在 set 时记下
    private byDoc = new Map<MercuryDocument, Term>()
    get(term:Term){
        for (const candidate of this.moduleMap.get(term.name)) {
            // 重建窗口期（invalidate 后、visit 完成前）visitResult 为空，跳过；
            // 否则 visitResult!.module 会抛异常、被 inferClause 的 catch 静默吞掉
            const targetTerm = candidate.visitResult?.module
            if (targetTerm && equalQualified(term,targetTerm)){
                return candidate
            }
        }
    }
    set(term:Term,doc:MercuryDocument){
        // 幂等：重建时同一 doc 会重复登记，先清旧条目（含历史残留的重复项）
        this.delete(doc)
        this.moduleMap.add(term.name,doc);
        this.byDoc.set(doc,term)
    }
    delete(doc:MercuryDocument){
        const term = this.byDoc.get(doc) ?? doc.visitResult?.module
        if (term) {
            // MultiMap.delete(key, value) 每次只删一条，循环清干净
            while (this.moduleMap.delete(term.name, doc)) { }
        }
        this.byDoc.delete(doc)
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
    // typeMap 键含 module（keyOfTypeCtor）：不同模块的同名类型不再互相覆盖；
    // typeNameIndex 按裸 name/arity 反查，供未限定引用做唯一模块解析
    private typeMap = new Map<string, TypeInfo>()
    private typeNameIndex = new Map<string, TypeInfo[]>()
    private funcMap = new Map<string, FuncInfo>()
    // 同名同元数的全部声明签名（重载候选；funcMap/funcs 单值表只存其一）
    private funcAltsMap = new Map<string, FuncInfo[]>()
    private predAltsMap = new Map<string, FuncInfo[]>()
    private byDocTypes = new Map<MercuryDocument, { typeKeys: string[]; typeInfos: TypeInfo[]; funcKeys: string[]; consKeys: string[] }>()
    private byDocAlts = new Map<MercuryDocument, { map: 'f' | 'p'; key: string; fi: FuncInfo }[]>()
    // 构造子名/元数 → 出现次数：hasCtor 查询 O(1)，避免每个歧义 functor 全扫 typeMap
    private ctorIndex = new Map<string, number>()
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
        const typeInfos: TypeInfo[] = []
        const consKeys: string[] = []
        for (const ti of vr.types.values()) {
            const k = keyOfTypeCtor(ti.ctor)
            this.typeMap.set(k, ti)
            typeKeys.push(k)
            typeInfos.push(ti)
            const nk = keyOf(ti.ctor.name, ti.ctor.arity)
            const arr = this.typeNameIndex.get(nk)
            if (arr) arr.push(ti)
            else this.typeNameIndex.set(nk, [ti])
            for (const ci of ti.constructors) {
                const ck = keyOf(ci.ctor, ci.arity)
                this.ctorIndex.set(ck, (this.ctorIndex.get(ck) ?? 0) + 1)
                consKeys.push(ck)
            }
        }
        const funcKeys: string[] = []
        const altEntries: { map: 'f' | 'p'; key: string; fi: FuncInfo }[] = []
        const regFunc = (fi: FuncInfo, map: 'f' | 'p', alts: Map<string, FuncInfo[]>) => {
            const k = keyOf(fi.name, fi.arity)
            this.funcMap.set(k, fi)
            funcKeys.push(k)
            pushAlt(alts, k, fi)
            altEntries.push({ map, key: k, fi })
        }
        for (const fi of vr.funcs.values()) regFunc(fi, 'f', this.funcAltsMap)
        for (const fi of vr.preds.values()) regFunc(fi, 'p', this.predAltsMap)
        this.byDocTypes.set(doc, { typeKeys, typeInfos, funcKeys, consKeys })
        this.byDocAlts.set(doc, altEntries)
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
            for (const ti of oldT.typeInfos) {
                const nk = keyOf(ti.ctor.name, ti.ctor.arity)
                const arr = this.typeNameIndex.get(nk)
                if (arr) {
                    const i = arr.indexOf(ti)
                    if (i >= 0) arr.splice(i, 1)
                    if (arr.length === 0) this.typeNameIndex.delete(nk)
                }
            }
            for (const k of oldT.funcKeys) this.funcMap.delete(k)
            for (const k of oldT.consKeys) {
                const n = (this.ctorIndex.get(k) ?? 1) - 1
                if (n <= 0) this.ctorIndex.delete(k)
                else this.ctorIndex.set(k, n)
            }
            this.byDocTypes.delete(doc)
        }
        const oldAlts = this.byDocAlts.get(doc)
        if (oldAlts) {
            for (const e of oldAlts) {
                const map = e.map === 'f' ? this.funcAltsMap : this.predAltsMap
                const arr = map.get(e.key)
                if (arr) {
                    const i = arr.indexOf(e.fi)
                    if (i >= 0) arr.splice(i, 1)
                    if (arr.length === 0) map.delete(e.key)
                }
            }
            this.byDocAlts.delete(doc)
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
    // 跨模块推断查询：ctor.module 已知时精确命中（module.name/arity）；
    // 未限定引用退回 typeNameIndex——同名类型跨多个模块时视为歧义，不猜
    lookupType(ctor: TypeCtor): TypeInfo | undefined {
        const exact = this.typeMap.get(keyOfTypeCtor(ctor))
        if (exact) return exact
        if (ctor.module) return undefined
        const cands = this.typeNameIndex.get(keyOf(ctor.name, ctor.arity)) ?? []
        const modules = new Set(cands.map(ti => ti.ctor.module ?? ''))
        return modules.size === 1 ? cands[0] : undefined
    }
    lookupFunc(name: string, arity: number): FuncInfo | undefined {
        return this.funcMap.get(keyOf(name, arity))
    }
    // 重载候选查询：func / pred / 合并（调用位置两者皆可）
    lookupFuncAlts(name: string, sem: number, alt: number): FuncInfo[] {
        return this.funcAltsMap.get(keyOf(name, sem)) ?? this.funcAltsMap.get(keyOf(name, alt)) ?? []
    }
    lookupPredAlts(name: string, sem: number, alt: number): FuncInfo[] {
        return this.predAltsMap.get(keyOf(name, sem)) ?? this.predAltsMap.get(keyOf(name, alt)) ?? []
    }
    lookupSigAlts(name: string, sem: number, alt: number): FuncInfo[] {
        const f = this.lookupFuncAlts(name, sem, alt)
        const p = this.lookupPredAlts(name, sem, alt)
        return f.length ? (p.length ? [...f, ...p] : f) : p
    }
    allTypeInfos(): Iterable<TypeInfo> {
        return this.typeMap.values()
    }
    // 导出索引里是否存在同名同元数的类型构造子（跨模块歧义检测用，O(1)）
    hasCtor(name: string, arity: number): boolean {
        return this.ctorIndex.has(keyOf(name, arity))
    }
}

// 重载候选收集：同一 name/arity 的每条声明都保留；签名完全相同的重复声明去重
function pushAlt(map: Map<string, FuncInfo[]>, key: string, fi: FuncInfo) {
    const sig = JSON.stringify({ a: fi.argTypes, r: fi.resultType })
    const arr = map.get(key)
    if (arr) {
        if (!arr.some(f => JSON.stringify({ a: f.argTypes, r: f.resultType }) === sig)) arr.push(fi)
    } else {
        map.set(key, [fi])
    }
}
