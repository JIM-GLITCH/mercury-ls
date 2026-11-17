import { MercuryDocument } from './document-manager'
// import { moduleMap } from './globalSpace'
import { MultiMap } from './multimap'
import { Term, moduleQualifiedName } from './term'
import { FuncInfo, TypeCtor, TypeInfo, keyOf, keyOfTypeCtor, sigCandidates } from './document-type'

// 限定名工具统一收敛在 term.ts（对 './2' 原始链与 .qualified 规范化形态都正确）；
// 此处 re-export 保持既有 import 路径不变
export { equalQualified, moduleQualifiedName } from './term'


export class ModuleManager {
    moduleMap = new MultiMap<string,MercuryDocument>
    // doc → 其 module 项：invalidate 后 visitResult 被清空，delete 时无法再从
    // visitResult 反查模块名，必须在 set 时记下
    private byDoc = new Map<MercuryDocument, Term>()
    get(moduleName:string){
        return this.getExact(moduleName)
    }
    private getExact(name:string){
        for (const candidate of this.moduleMap.get(name)) {
            // 重建窗口期（invalidate 后、visit 完成前）visitResult 为空，跳过；
            // 否则 visitResult!.module 会抛异常、被 inferClause 的 catch 静默吞掉
            const targetTerm = candidate.visitResult?.module
            if (targetTerm && moduleQualifiedName(targetTerm) === name){
                return candidate
            }
        }
    }
    set(term:Term,doc:MercuryDocument){
        // 幂等：重建时同一 doc 会重复登记，先清旧条目（含历史残留的重复项）
        this.delete(doc)
        this.moduleMap.add(moduleQualifiedName(term),doc);
        this.byDoc.set(doc,term)
    }
    delete(doc:MercuryDocument){
        const term = this.byDoc.get(doc) ?? doc.visitResult?.module
        if (term) {
            // MultiMap.delete(key, value) 每次只删一条，循环清干净
            while (this.moduleMap.delete(moduleQualifiedName(term), doc)) { }
        }
        this.byDoc.delete(doc)
    }
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
    // typeIndex 按裸 name 存全部类型（func/pred 的 sigAltsMap 同构）：
    // arity/module 在 TypeInfo.ctor 上过滤；ctor.module 区分同名跨模块类型，
    // 未限定引用做唯一模块解析
    private typeIndex = new Map<string, TypeInfo[]>()
    // 类型构造子键（module.name/arity）→ 声明它的文档：收全部类型（含未导出的），
    // 供 goto-type-def 定位非导出类型的定义位置
    private typeDocMap = new Map<string, MercuryDocument>()
    // 同名的全部签名声明（func/pred 同命名空间；key 为裸 name，元数在
    // FuncInfo.arity 上过滤，查询走 sigCandidates 的 sem→alt 遮蔽语义）
    private sigAltsMap = new Map<string, FuncInfo[]>()
    private byDocTypes = new Map<MercuryDocument, { typeKeys: string[]; typeInfos: TypeInfo[]; consKeys: string[] }>()
    private byDocAlts = new Map<MercuryDocument, { key: string; fi: FuncInfo }[]>()
    // 构造子名/元数 → 出现次数：hasCtor 查询 O(1)，避免每个歧义 functor 全扫 typeIndex
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
        for (const arr of vr.types.values()) for (const ti of arr) {
            const k = keyOfTypeCtor(ti.ctor)
            this.typeDocMap.set(k, doc)
            typeKeys.push(k)
            typeInfos.push(ti)
            const arr = this.typeIndex.get(ti.ctor.name)
            if (arr) arr.push(ti)
            else this.typeIndex.set(ti.ctor.name, [ti])
            for (const ci of ti.constructors) {
                const ck = keyOf(ci.ctor, ci.arity)
                this.ctorIndex.set(ck, (this.ctorIndex.get(ck) ?? 0) + 1)
                consKeys.push(ck)
            }
        }
        const altEntries: { key: string; fi: FuncInfo }[] = []
        for (const arr of vr.sigAlts.values()) {
            for (const fi of arr) {
                pushAlt(this.sigAltsMap, fi.name, fi)
                altEntries.push({ key: fi.name, fi })
            }
        }
        this.byDocTypes.set(doc, { typeKeys, typeInfos, consKeys })
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
            for (const k of oldT.typeKeys) {
                this.typeDocMap.delete(k)
            }
            for (const ti of oldT.typeInfos) {
                const arr = this.typeIndex.get(ti.ctor.name)
                if (arr) {
                    const i = arr.indexOf(ti)
                    if (i >= 0) arr.splice(i, 1)
                    if (arr.length === 0) this.typeIndex.delete(ti.ctor.name)
                }
            }
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
                const arr = this.sigAltsMap.get(e.key)
                if (arr) {
                    const i = arr.indexOf(e.fi)
                    if (i >= 0) arr.splice(i, 1)
                    if (arr.length === 0) this.sigAltsMap.delete(e.key)
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
            // export 项的 .qualified 是所属模块点分名字符串
            if (t.qualified === moduleName) result.push(t)
        })
        return result
    }
    // 跨模块推断查询：ctor.module 已知时精确命中（module.name/arity）；
    // 未限定引用退回裸 name 候选——同名类型跨多个模块时视为歧义，不猜
    lookupType(ctor: TypeCtor): TypeInfo | undefined {
        const cands = this.typeIndex.get(ctor.name)?.filter(ti => ti.ctor.arity === ctor.arity)
        if (!cands?.length) return undefined
        if (ctor.module) return cands.find(ti => ti.ctor.module === ctor.module)
        const modules = new Set(cands.map(ti => ti.ctor.module ?? ''))
        return modules.size === 1 ? cands[0] : undefined
    }
    // 类型构造子 → 声明文档：module 已知精确命中；未限定时同名跨模块
    // 歧义返回 undefined（不猜，调用方回退按名搜索）
    lookupTypeDoc(ctor: TypeCtor): MercuryDocument | undefined {
        const doc = this.typeDocMap.get(keyOfTypeCtor(ctor))
        if (doc) return doc
        if (ctor.module) return undefined
        const ti = this.lookupType(ctor)
        return ti ? this.typeDocMap.get(keyOfTypeCtor(ti.ctor)) : undefined
    }
    // 裸 name/arity → 全部声明该类型的文档（含未导出类型；goto-def 兜底用）
    lookupTypeDocs(name: string, arity: number): MercuryDocument[] {
        const docs: MercuryDocument[] = []
        for (const ti of this.typeIndex.get(name)?.filter(ti => ti.ctor.arity === arity) ?? []) {
            const doc = this.typeDocMap.get(keyOfTypeCtor(ti.ctor))
            if (doc && !docs.includes(doc)) docs.push(doc)
        }
        return docs
    }
    // 重载候选查询：func / pred / 合并（调用位置两者皆可；
    // 各 kind 内部仍是 sem→alt 遮蔽，func 候选排在 pred 前）
    lookupFuncAlts(name: string, sem: number, alt: number): FuncInfo[] {
        return sigCandidates(this.sigAltsMap, name, sem, alt, 'func')
    }
    lookupPredAlts(name: string, sem: number, alt: number): FuncInfo[] {
        return sigCandidates(this.sigAltsMap, name, sem, alt, 'pred')
    }
    lookupSigAlts(name: string, sem: number, alt: number): FuncInfo[] {
        return [...this.lookupFuncAlts(name, sem, alt), ...this.lookupPredAlts(name, sem, alt)]
    }
    allTypeInfos(): Iterable<TypeInfo> {
        return [...this.typeIndex.values()].flat()
    }
    // 导出索引里是否存在同名同元数的类型构造子（跨模块歧义检测用，O(1)）
    hasCtor(name: string, arity: number): boolean {
        return this.ctorIndex.has(keyOf(name, arity))
    }
}

// 重载候选收集：同一 name 的每条声明都保留；签名完全相同的重复声明去重
//（kind+arity 进签名键，func/pred 同签名与不同元数都不误去重）
function pushAlt(map: Map<string, FuncInfo[]>, name: string, fi: FuncInfo) {
    const sig = JSON.stringify({ k: fi.kind, a: fi.arity, t: fi.argTypes, r: fi.resultType })
    const arr = map.get(name)
    if (arr) {
        if (!arr.some(f => JSON.stringify({ k: f.kind, a: f.arity, t: f.argTypes, r: f.resultType }) === sig)) arr.push(fi)
    } else {
        map.set(name, [fi])
    }
}
