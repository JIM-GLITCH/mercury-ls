import { Location, ReferenceParams } from 'vscode-languageserver'
import { semanticArityOf, sleep } from './utils'
import { Term, search, termRange } from './term'
import { MercuryDocument, mercuryDocuments } from './document-manager'
import { equalQualified } from './document-moduleManager'
import { URI } from 'vscode-uri'

export async function ReferenceProvider(params:ReferenceParams) {
    let uri  = params.textDocument.uri;
    let pos = params.position
    let document ;
    while( !(document = mercuryDocuments.getOrCreateDocument(URI.parse(uri)))){
        await sleep(100);
    }
    let term = search(document.parseResult.value,pos);

    if(!term) return [];
    // 目标符号所属模块：引用带限定名则取其限定，否则为所在文档的模块
    const termModule: Term | undefined = term.qualified ?? document.visitResult?.module
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
            findReferences(term,termModule,refs);
            return refs;
        }
        case 'pred':{
            let refs:Location[] = [];
            findReferences(term,termModule,refs);
            return refs;
        }
        case 'type':{
            // 类型引用在独立的 typeReference 索引里，不会混入 pred / inst 引用
            let refs:Location[] = [];
            findTypeReferences(term,termModule,refs);
            return refs;
        }
        case 'inst':{
            // inst 引用在独立的 instReference 索引里
            let refs:Location[] = [];
            findInstReferences(term,termModule,refs);
            return refs;
        }
        case 'mode':{
            // mode 引用在独立的 modeReference 索引里
            let refs:Location[] = [];
            findModeReferences(term,termModule,refs);
            return refs;
        }
        case 'module':{
            // 模块名的显式出现（import/限定词/end_module）一律保留，不做可见性过滤
            let refs:Location[] = [];
            findReferences(term,undefined,refs);
            return refs;
        }
        default:
            let refs:Location[] = [];
            findReferences(term,termModule,refs);
            return refs;
    }
    return [];
}
// 引用的可见性过滤（Mercury 名字解析规则）：
// - 引用带限定名 M.f：只保留限定到目标模块 termModule 的——
//   显式限定到其它模块的同名引用直接排除（这是 qualified 不一致混入的根源）；
// - 非限定引用 f：只保留目标模块自身、或 import 了目标模块的文档；
//   文档没有模块声明（无法判定归属）时不过滤
function visibleRef(refTerm: Term, termModule: Term | undefined, doc: MercuryDocument): boolean {
    if (!termModule) return true
    const q = refTerm.qualified
    if (q) return equalQualified(q, termModule)
    const vr = doc.visitResult
    if (!vr?.module) return true
    if (equalQualified(vr.module, termModule)) return true
    return (vr.imports ?? []).some(imp => equalQualified(imp, termModule))
}
function findReferences(term:Term, termModule:Term|undefined, refs:Location[]){
    for (const doc of mercuryDocuments.all) {
        for (const refTerm of doc.visitResult?.reference.get(term.name)??[]) {
            if(semanticArityOf(refTerm)!=semanticArityOf(term)) continue;
            if(!visibleRef(refTerm, termModule, doc)) continue;
            refs.push({uri:doc.uri.toString(),range:termRange(refTerm)})
        }
    }
}
function findTypeReferences(term:Term, termModule:Term|undefined, refs:Location[]){
    for (const doc of mercuryDocuments.all) {
        for (const refTerm of doc.visitResult?.typeReference.get(term.name)??[]) {
            if(semanticArityOf(refTerm)!=semanticArityOf(term)) continue;
            if(!visibleRef(refTerm, termModule, doc)) continue;
            refs.push({uri:doc.uri.toString(),range:termRange(refTerm)})
        }
    }
}
function findInstReferences(term:Term, termModule:Term|undefined, refs:Location[]){
    for (const doc of mercuryDocuments.all) {
        for (const refTerm of doc.visitResult?.instReference.get(term.name)??[]) {
            if(semanticArityOf(refTerm)!=semanticArityOf(term)) continue;
            if(!visibleRef(refTerm, termModule, doc)) continue;
            refs.push({uri:doc.uri.toString(),range:termRange(refTerm)})
        }
    }
}
function findModeReferences(term:Term, termModule:Term|undefined, refs:Location[]){
    for (const doc of mercuryDocuments.all) {
        for (const refTerm of doc.visitResult?.modeReference.get(term.name)??[]) {
            if(semanticArityOf(refTerm)!=semanticArityOf(term)) continue;
            if(!visibleRef(refTerm, termModule, doc)) continue;
            refs.push({uri:doc.uri.toString(),range:termRange(refTerm)})
        }
    }
}