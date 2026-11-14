import { DefinitionParams, Location, TextDocumentPositionParams, TypeDefinitionParams } from 'vscode-languageserver'
import { sameArity, semanticArityOf, sleep, termTokenRange } from './utils'
import { Term, search, termRange, moduleQualifiedName } from './term'
import { DefTerm, Document } from './document'
import { EMPTY_STREAM, Stream, stream } from './stream'
import { MercuryDocument } from './document-manager'
import { URI } from 'vscode-uri'
import type { MercuryServices } from './services'

export async function DefinitionProvider(services: MercuryServices, params:DefinitionParams):Promise<Location[]> {
    // 先找到指定位置的term 
    let termAndUri = await findAtTextDocumentPositionTerm(services, params);
    if(!termAndUri) return []
    return findDefTerms(services, termAndUri)
        .map(uriTermToLocation).toArray()
}

export async function TypeDefinitionProvider(services: MercuryServices, params: TypeDefinitionParams): Promise<Location[]> {
    const termAndUri = await findAtTextDocumentPositionTerm(services, params)
    if (!termAndUri) return []

    const { term, uri } = termAndUri
    const document = services.documents.getOrCreateDocument(uri)!

    // If the term is a type or constructor reference, navigate to its definition
    if (term.semanticType && ['type', 'constructor'].includes(term.semanticType)) {
        return findDefTerms(services, termAndUri)
            .filter(uriTerm => uriTerm.term.semanticType === 'type' || uriTerm.term.semanticType === 'constructor')
            .map(uriTermToLocation)
            .toArray()
    }

    // If the term is a variable with an inferred type, navigate to the type's definition
    if (term.semanticType === 'variable') {
        const inferred = document.visitResult?.inferred.get(term)
        if (inferred?.type && inferred.type.kind === 'ctor') {
            const typeCtor = inferred.type.ctor
            // Create a temporary term for the type constructor to use findDefTerms
            const typeTerm: Partial<Term> = {
                name: typeCtor.name,
                arity: typeCtor.arity,
                semanticArity: typeCtor.arity,
                semanticType: 'type',
            }
            // ctor.module 精确定位声明模块（typeMap 含未导出类型）；
            // 找不到回退当前文档 → 全局导出索引的旧路径
            const ownerDoc = services.exportManager.lookupTypeDoc(typeCtor)
            return findDefTerms(services, { term: typeTerm as Term, uri: ownerDoc?.uri ?? uri })
                .filter(uriTerm => uriTerm.term.semanticType === 'type')
                .map(uriTermToLocation)
                .toArray()
        }
    }

    return []
}

// function findDefinitionTermWithoutSamantic(term:Term,document:MercuryDocument){
//     let defterm1 =findDefinitionTerm('func',term,document)
//     let defterm2 = findDefinitionTerm('pred',term,document)
//     return defterm1.concat(defterm2)
// }
function findDefinitionTerm(services: MercuryServices, term:Term,document:MercuryDocument){
    // 推断消歧结果优先：inferred.sig.module / 推断类型 ctor.module 直接给出
    // 定义模块——覆盖非限定跨模块调用（imports 逐层找可能落空）与重载消歧；
    // 推断未跑（非 priority 文档）时为 undefined，回退下面的名字路径
    const info = document.visitResult?.inferred.get(term)
    const inferredModule = (term.semanticType === 'func' || term.semanticType === 'pred')
        ? info?.sig?.module
        : term.semanticType === 'constructor' && info?.type.kind === 'ctor'
            ? info.type.ctor.module : undefined
    if (inferredModule) {
        const doc = services.moduleManager.get(inferredModule)
        const defs = doc && findDefTermInThisDocument(term, doc)
        if (defs && !defs.isEmpty()) return defs
    }
    // term qualified
    if(term.qualified){
        let doc =services.moduleManager.get(term.qualified)
        if(!doc) return stream([]);
        let res = findDefTermInThisDocument(term,doc)
        return res
    }
    // 在本文件查找 如果找到就返回
    let defs1 = findDefTermInThisDocument(term,document)
    if (!defs1.isEmpty())
        return defs1;
    // 在本文件没找到 在其他文件里查找
    let defs2 = findDefTermInOtherDocument(services, term,document)
    return defs2;
}

function findDefTermInThisDocument( term: Term, document: MercuryDocument){
    let uri = document.uri;
    let definition =document.visitResult?.definition
    if(!definition)
        return stream([])
    // 按引用处的 semanticType 限定可匹配的定义类别：
    // 例如 type 引用不应命中同名的 inst / pred / mode 定义
    const defKinds = defKindsForRef(term.semanticType)
    const matches = definition.get(term.name)
        .filter(x=>sameArity(x,term))
        .filter(x=>!defKinds || defKinds.includes(x.semanticType ?? ''))
    // 优先实现子句定义；只有声明（interface decl）时回退 decl 项
    const defs = matches.filter(x => !x.isDeclaration)
    const pool = defs.length ? defs : matches
    let res = stream(pool)
        .map(term=>(uriTerm.create(uri,term)))
    return res;

}

/**
 * 引用处的 semanticType → 允许匹配的定义 semanticType 集合。
 * 未列出的引用（如子句体里的 functor 调用，可能是 pred/func/构造子）
 * 在解析层无法区分类别，返回 undefined 表示不过滤。
 */
export function defKindsForRef(refType?: string): string[] | undefined {
    switch (refType) {
        case 'type': return ['type']
        case 'fieldname': return ['fieldname']
        case 'inst': return ['inst']
        case 'mode': return ['mode']
        case 'typeclass': return ['typeclass']
        case 'instance': return ['instance']
        case 'mutable': return ['mutable']
        default: return undefined
    }
}
function findDefTermInOtherDocument(services: MercuryServices, term: Term, document: MercuryDocument){
    // 对于 type 和 constructor，使用 exportManager 进行全局查找
    // 因为它们经常通过多层 import 传播
    if (term.semanticType === 'type' || term.semanticType === 'constructor') {
        const defKinds = defKindsForRef(term.semanticType)
        const matchDef = (x: Term) => sameArity(x, term) && (!defKinds || defKinds.includes(x.semanticType ?? ''))
        // 导出索引：interface 段导出的符号
        const exports = services.exportManager.get(term.name)
        const fromExports = exports
            ? stream(exports)
                .filter(matchDef)
                .map(exportTerm => {
                    // exportTerm.qualified 指向所属模块，从 moduleManager 获取文档
                    const moduleTerm = exportTerm.qualified
                    if (!moduleTerm) return null
                    const doc = services.moduleManager.get(moduleTerm)
                    if (!doc) return null
                    return uriTerm.create(doc.uri, exportTerm)
                })
                .nonNullable()
            : stream<uriTerm>([])
        // typeMap 收全部类型（含未导出）：按 name/arity 找声明文档兜底，
        // 否则 implementation 段声明的类型 goto-def 永远落空
        const typeDocs = services.exportManager.lookupTypeDocs(term.name, semanticArityOf(term))
        const fromTypeDocs = stream(typeDocs).flatMap(d => findDefTermInThisDocument(term, d))
        return fromExports.concat(fromTypeDocs)
            .distinct(u => `${u.uri.toString()}:${termTokenRange(u.term).start.line}:${termTokenRange(u.term).start.character}`)
    }

    // 对于 func 和 pred，保持单层查找（通常在当前模块或直接 import 中定义）
    let imports = document.visitResult?.imports;
    if(!imports){
        return stream([])
    }

    let res = stream(imports)
    .map(x => services.moduleManager.get(x))
    .nonNullable()
    .flatMap(doc=>findDefTermInThisDocument(term,doc))

    // exportManager 兜底：interface 导出的 func/pred 带 module 限定名，
    // 覆盖 imports 缺失/推断未跑（非 priority 文档 inferred 为空）的场景；
    // 与 hover 的 lookupFunc 全局兜底同源
    const exports = services.exportManager.get(term.name)
    const fromExports = exports
        ? stream(exports)
            .filter(x => sameArity(x, term))
            .flatMap(exp => {
                const doc = exp.qualified ? services.moduleManager.get(exp.qualified) : undefined
                return doc ? findDefTermInThisDocument(term, doc) : stream<uriTerm>([])
            })
        : stream<uriTerm>([])

    return res.concat(fromExports)
        .distinct(u => `${u.uri.toString()}:${termTokenRange(u.term).start.line}:${termTokenRange(u.term).start.character}`);
}

export interface uriTerm{
    uri:URI,
    term:Term
}
export namespace uriTerm{
    export function create(uri:URI,term:Term):uriTerm{
        return{
            uri,term
        }
    }
}
export function uriTermToLocation(uriTerm:uriTerm){
    return Location.create(
        uriTerm.uri.toString(),
        termTokenRange(uriTerm.term)
    )
}

/**
 * 记录语法 `^` 处的字段说明符 → field access function 定义。
 * Mercury 参考手册 §2.15.2：field specifier `field/N` 展开为
 * `field/(N+1)`（selection）与 `'field :='/(N+2)`（update）；另外
 * `field :: Type` 的字段标签（field label）是这些函数的来源。
 */
function findFieldAccessDefinitions(
    services: MercuryServices, term: Term, document: MercuryDocument,
): Stream<uriTerm> {
    const spec = term.fieldAccess!
    const selection = { name: spec.selectionName, arity: spec.selectionArity, kinds: ['func'] }
    const update = { name: spec.updateName, arity: spec.updateArity, kinds: ['func'] }
    const label = { name: spec.base, arity: 0, kinds: ['fieldname'] }
    const queries = spec.role === 'update'
        ? [update, selection, label]
        : [selection, update, label]
    const docs: MercuryDocument[] = [document]
    for (const imp of document.visitResult?.imports ?? []) {
        const doc = services.moduleManager.get(imp)
        if (doc && !docs.includes(doc)) docs.push(doc)
    }
    const result: uriTerm[] = []
    const seen = new Set<string>()
    const push = (uri: URI, def: Term) => {
        const key = `${uri.toString()}:${def.token.line}:${def.token.col}`
        if (seen.has(key)) return
        seen.add(key)
        result.push(uriTerm.create(uri, def))
    }
    for (const q of queries) {
        for (const doc of docs) {
            const vr = doc.visitResult
            if (!vr) continue
            // definition 表已合并 decl/def
            for (const def of vr.definition.get(q.name)) {
                if (semanticArityOf(def) !== q.arity) continue
                if (!q.kinds.includes(def.semanticType ?? '')) continue
                push(doc.uri, def)
            }
        }
        // 别的模块 interface 段导出的同名函数
        for (const exp of services.exportManager.get(q.name)) {
            if (semanticArityOf(exp) !== q.arity || !q.kinds.includes(exp.semanticType ?? '')) continue
            const doc = exp.qualified ? services.moduleManager.get(exp.qualified) : undefined
            if (doc) push(doc.uri, exp)
        }
    }
    return stream(result)
}

export  function findDefTerms(services: MercuryServices, params:uriTerm):Stream<uriTerm> {
    let {term,uri} = params;
    let document  = services.documents.getOrCreateDocument(uri)!;
    if (term.fieldAccess) return findFieldAccessDefinitions(services, term, document);
    switch (term.semanticType!) {
        case 'variable':{
            // 在 variable所在的clause里查找
            let node = term.clause!.varMap.get(term.name)[0];
            if(!node) return stream([]);
            return stream([{
                uri,
                term:node
            }]);
        }
        case 'func':
        case 'pred':
        case 'type':
        case 'fieldname':
        case 'inst':
        case 'mode':
        case 'typeclass':
        case 'instance':
        case 'mutable':
        case 'operator':{
            return findDefinitionTerm(services, term,document);

        }

        case 'module':{
            const targetDoc = services.moduleManager.get(moduleQualifiedName(term));
            if(!targetDoc)
                return stream([]);
            let module = targetDoc.visitResult?.module
            if(!module)
                return stream([]);
            let uri = targetDoc.uri ;
            return stream([{
                uri,
                term:module
            }])
        }
        default:{
            // 数据/表达式位置的 functor（semanticType 未标注，如 `version_array.init(...)`、
            // 构造子引用）：解析层无法区分 func 调用 / 构造子 / pred 引用，
            // 不限类别，按名字与语义元数匹配 definition
            return findDefinitionTerm(services, term, document);
        }
    }
}

export async function findAtTextDocumentPositionTerm(services: MercuryServices, params: TextDocumentPositionParams){
    let pos = params.position;
    let uri = URI.parse(params.textDocument.uri);
    while( !services.documents.getOrCreateDocument(uri)){
        await sleep(100);
    }
    let document = services.documents.getOrCreateDocument(uri)!
    let rootNode =  document.parseResult.value 
    let term = search(rootNode,pos);
    if (term) return{
        uri ,
        term
    }
}
