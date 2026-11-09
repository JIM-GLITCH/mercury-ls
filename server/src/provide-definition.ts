import { DefinitionParams, Location, TextDocumentPositionParams, TypeDefinitionParams } from 'vscode-languageserver'
import { sameArity, semanticArityOf, sleep, termTokenRange } from './utils'
import { Term, search, termRange } from './term'
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
        const inferred = services.index.get(document)?.inferred.get(term)
        if (inferred?.type && inferred.type.kind === 'ctor') {
            const typeCtor = inferred.type.ctor
            // Create a temporary term for the type constructor to use findDefTerms
            const typeTerm: Partial<Term> = {
                name: typeCtor.name,
                arity: typeCtor.arity,
                semanticArity: typeCtor.arity,
                semanticType: 'type',
            }
            return findDefTerms(services, { term: typeTerm as Term, uri })
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
    // term qualified
    if(term.qualified){
        let doc =services.index.getModuleDoc(term.qualified)
        if(!doc) return stream([]);
        let res = findDefTermInThisDocument(services,term,doc)
        return res
    }
    // 在本文件查找 如果找到就返回
    let defs1 = findDefTermInThisDocument(services,term,document)
    if (!defs1.isEmpty())
        return defs1;
    // 在本文件没找到 在其他文件里查找
    let defs2 = findDefTermInOtherDocument(services, term,document)
    return defs2;
}

function findDefTermInThisDocument(services: MercuryServices, term: Term, document: MercuryDocument){
    let uri = document.uri;
    let definition =services.index.get(document)?.definition
    if(!definition)
        return stream([])
    // 按引用处的 semanticType 限定可匹配的定义类别：
    // 例如 type 引用不应命中同名的 inst / pred / mode 定义
    const defKinds = defKindsForRef(term.semanticType)
    let defs = stream(definition.get(term.name))
        .filter(x=>sameArity(x,term))
        .filter(x=>!defKinds || defKinds.includes(x.semanticType ?? ''))
        .map(term=>(uriTerm.create(uri,term)))
        .toArray()
    if (defs.length) return stream(defs)
    // 只有声明而没有定义子句的目标（如 `:- pred g(int).` 的高阶谓词值引用 `G = g`）
    // 也应能跳转，回退到声明项
    const declaration = services.index.get(document)?.declaration
    if (!declaration) return stream([])
    let decls = stream(declaration.get(term.name))
        .filter(x=>sameArity(x,term))
        .filter(x=>!defKinds || defKinds.includes(x.semanticType ?? ''))
        .map(term=>(uriTerm.create(uri,term)))
        .toArray()
    return stream(decls)

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
    // 对于 type 和 constructor，使用全局符号表的导出项查找
    // 因为它们经常通过多层 import 传播
    if (term.semanticType === 'type' || term.semanticType === 'constructor') {
        const exports = services.index.getExportedTerms(term.name)
        if (!exports) return stream([])

        const defKinds = defKindsForRef(term.semanticType)
        return stream(exports)
            .filter(x => sameArity(x, term))
            .filter(x => !defKinds || defKinds.includes(x.semanticType ?? ''))
            .map(exportTerm => {
                // exportTerm.qualified 指向所属模块，从全局符号表取回文档
                const moduleTerm = exportTerm.qualified
                if (!moduleTerm) return null
                const doc = services.index.getModuleDoc(moduleTerm)
                if (!doc) return null
                return uriTerm.create(doc.uri, exportTerm)
            })
            .nonNullable()
    }

    // 对于 func 和 pred，保持单层查找（通常在当前模块或直接 import 中定义）
    let imports = services.index.get(document)?.imports;
    if(!imports){
        return stream([])
    }

    let res = stream(imports)
    .map(x => services.index.getModuleDoc(x))
    .nonNullable()
    .flatMap(doc=>findDefTermInThisDocument(services,term,doc))

    return res;
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
    for (const imp of services.index.get(document)?.imports ?? []) {
        const doc = services.index.getModuleDoc(imp)
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
            const vr = services.index.get(doc)!
            if (!vr) continue
            for (const def of [...vr.definition.get(q.name), ...vr.declaration.get(q.name)]) {
                if (semanticArityOf(def) !== q.arity) continue
                if (!q.kinds.includes(def.semanticType ?? '')) continue
                push(doc.uri, def)
            }
        }
        // 别的模块 interface 段导出的同名函数
        for (const exp of services.index.getExportedTerms(q.name)) {
            if (semanticArityOf(exp) !== q.arity || !q.kinds.includes(exp.semanticType ?? '')) continue
            const doc = exp.qualified ? services.index.getModuleDoc(exp.qualified) : undefined
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
            let document = services.index.getModuleDoc(term);
            if(!document)
                return stream([]);
            let module = services.index.get(document)?.module
            if(!module)
                return stream([]);
            let uri = document.uri ;
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
