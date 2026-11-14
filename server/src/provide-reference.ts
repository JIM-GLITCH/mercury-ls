import { Location, ReferenceParams } from 'vscode-languageserver'
import { semanticArityOf, sleep } from './utils'
import { FieldAccessInfo, Term, moduleQualifiedName, search, termRange } from './term'
import { MercuryDocument } from './document-manager'
import { URI } from 'vscode-uri'
import type { MercuryServices } from './services'

export async function ReferenceProvider(services: MercuryServices, params:ReferenceParams) {
    let uri  = params.textDocument.uri;
    let pos = params.position
    let document ;
    while( !(document = services.documents.getOrCreateDocument(URI.parse(uri)))){
        await sleep(100);
    }
    let term = search(document.parseResult.value,pos);

    if(!term) return [];
    // 目标符号所属模块的点分名：引用带限定名则取其限定，否则为所在文档的模块
    const docModule = document.visitResult?.module
    const termModule: string | undefined = term.qualified
        ?? (docModule ? moduleQualifiedName(docModule) : undefined)
    switch (term.semanticType) {
        case 'variable':{
            // 查找 variable的引用 只需要在这个varaible在的clause范围里查找
            let refs:Location[] = [];
            for( const refTerm of term.clause!.varMap.get(term.name)){
                refs.push({uri,range:termRange(refTerm)});
            }
            return refs;
        }
        case 'func':{
            let refs:Location[] = [];
            findReferences(services, term,termModule,refs);
            return refs;
        }
        case 'pred':{
            let refs:Location[] = [];
            findReferences(services, term,termModule,refs);
            return refs;
        }
        case 'type':{
            // 类型引用在独立的 typeReference 索引里，不会混入 pred / inst 引用
            let refs:Location[] = [];
            findTypeReferences(services, term,termModule,refs);
            return refs;
        }
        case 'inst':{
            // inst 引用在独立的 instReference 索引里
            let refs:Location[] = [];
            findInstReferences(services, term,termModule,refs);
            return refs;
        }
        case 'mode':{
            // mode 引用在独立的 modeReference 索引里
            let refs:Location[] = [];
            findModeReferences(services, term,termModule,refs);
            return refs;
        }
        case 'module':{
            // 模块名的显式出现（import/限定词/end_module）一律保留，不做可见性过滤
            let refs:Location[] = [];
            findReferences(services, term,undefined,refs);
            return refs;
        }
        default:
            let refs:Location[] = [];
            findReferences(services, term,termModule,refs);
            return refs;
    }
    return [];
}
// 引用的可见性过滤（Mercury 名字解析规则）：
// - 引用带限定名 M.f：只保留限定到目标模块 termModule 的——
//   显式限定到其它模块的同名引用直接排除（这是 qualified 不一致混入的根源）；
// - 非限定引用 f：只保留目标模块自身、或 import 了目标模块的文档；
//   文档没有模块声明（无法判定归属）时不过滤
function visibleRef(refTerm: Term, termModule: string | undefined, doc: MercuryDocument): boolean {
    if (!termModule) return true
    const q = refTerm.qualified
    if (q) return q === termModule
    const vr = doc.visitResult
    if (!vr?.module) return true
    if (moduleQualifiedName(vr.module) === termModule) return true
    return (vr.imports ?? []).some(imp => moduleQualifiedName(imp) === termModule)
}
// 记录语法 `^` 字段说明符的引用名（派生规则见 term.ts 的 FieldAccessInfo）：
// 在 `^ elem(I)` 上是 elem；在 `'elem :='` 定义上要反推回 elem；
// 在 elem/2 选择函数或 `elem :: T` 字段标签上就是 elem 本身。
function fieldRefBase(term: Term): string | undefined {
    if (term.fieldAccess) return term.fieldAccess.base
    if (term.name.endsWith(' :=')) return term.name.slice(0, -3)
    if (term.semanticType === 'func' || term.semanticType === 'fieldname') return term.name
    return undefined
}
function matchesFieldRef(term: Term, fs: FieldAccessInfo): boolean {
    if (term.fieldAccess) return fs.base === term.fieldAccess.base
    if (term.name.endsWith(' :='))
        return fs.updateName === term.name && fs.updateArity === semanticArityOf(term)
    if (term.semanticType === 'fieldname') return fs.base === term.name
    if (term.semanticType === 'func')
        return fs.selectionName === term.name && fs.selectionArity === semanticArityOf(term)
    return false
}
function findReferences(services: MercuryServices, term:Term, termModule:string|undefined, refs:Location[]){
    const seen = new Set<string>()
    const push = (doc: MercuryDocument, refTerm: Term) => {
        const uri = doc.uri.toString()
        const range = termRange(refTerm)
        const key = `${uri}:${range.start.line}:${range.start.character}`
        if (seen.has(key)) return
        seen.add(key)
        refs.push({uri, range})
    }
    for (const doc of services.documents.all) {
        for (const refTerm of doc.visitResult?.reference.get(term.name)??[]) {
            if(semanticArityOf(refTerm)!=semanticArityOf(term)) continue;
            if(!visibleRef(refTerm, termModule, doc)) continue;
            push(doc, refTerm)
        }
    }
    // 语法糖侧：field specifier `^ elem(...)` 与它展开成的 field access function
    // 名字不同、元数不同，普通按名+元数查找搜不到，这里按派生关系补上
    const base = fieldRefBase(term)
    if (!base) return
    for (const doc of services.documents.all) {
        for (const refTerm of (doc.visitResult?.reference.get(base) ?? []) as Term[]) {
            const fs: FieldAccessInfo | undefined = refTerm.fieldAccess
            if (!fs || fs.base !== base) continue
            if (!matchesFieldRef(term, fs)) continue
            if(!visibleRef(refTerm, termModule, doc)) continue;
            push(doc, refTerm)
        }
    }
}
function findTypeReferences(services: MercuryServices, term:Term, termModule:string|undefined, refs:Location[]){
    for (const doc of services.documents.all) {
        for (const refTerm of doc.visitResult?.typeReference.get(term.name)??[]) {
            if(semanticArityOf(refTerm)!=semanticArityOf(term)) continue;
            if(!visibleRef(refTerm, termModule, doc)) continue;
            refs.push({uri:doc.uri.toString(),range:termRange(refTerm)})
        }
    }
}
function findInstReferences(services: MercuryServices, term:Term, termModule:string|undefined, refs:Location[]){
    for (const doc of services.documents.all) {
        for (const refTerm of doc.visitResult?.instReference.get(term.name)??[]) {
            if(semanticArityOf(refTerm)!=semanticArityOf(term)) continue;
            if(!visibleRef(refTerm, termModule, doc)) continue;
            refs.push({uri:doc.uri.toString(),range:termRange(refTerm)})
        }
    }
}
function findModeReferences(services: MercuryServices, term:Term, termModule:string|undefined, refs:Location[]){
    for (const doc of services.documents.all) {
        for (const refTerm of doc.visitResult?.modeReference.get(term.name)??[]) {
            if(semanticArityOf(refTerm)!=semanticArityOf(term)) continue;
            if(!visibleRef(refTerm, termModule, doc)) continue;
            refs.push({uri:doc.uri.toString(),range:termRange(refTerm)})
        }
    }
}
