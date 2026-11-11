import { DefinitionParams, Location, TextDocumentPositionParams, TypeDefinitionParams } from 'vscode-languageserver'
import { moduleQualifiedName, sameArity, semanticArityOf, sleep, termTokenRange } from './utils'
import { Term, search } from './term'
import { Stream, stream } from './stream'
import { MercuryDocument } from './document-manager'
import { URI } from 'vscode-uri'
import type { MercuryServices } from './services'
import type { SymbolEntry } from './document-index'

export async function DefinitionProvider(services: MercuryServices, params: DefinitionParams): Promise<Location[]> {
    const termAndUri = await findAtTextDocumentPositionTerm(services, params)
    if (!termAndUri) return []
    return findDefTerms(services, termAndUri)
        .map(uriTermToLocation).toArray()
}

export async function TypeDefinitionProvider(services: MercuryServices, params: TypeDefinitionParams): Promise<Location[]> {
    const termAndUri = await findAtTextDocumentPositionTerm(services, params)
    if (!termAndUri) return []

    const { term, uri } = termAndUri
    const document = services.documents.getOrCreateDocument(uri)!

    // 类型/构造子引用：跳到类型定义
    if (term.semanticType && ['type', 'constructor'].includes(term.semanticType)) {
        return findDefTerms(services, termAndUri)
            .filter(uriTerm => uriTerm.term.semanticType === 'type' || uriTerm.term.semanticType === 'constructor')
            .map(uriTermToLocation)
            .toArray()
    }

    // 变量：用阶段 3 推导出的类型名找类型定义
    const inferred = document.inferred?.get(term)
    if (inferred?.type.kind === 'type') {
        const entry = services.index.get(inferred.type.name).find(e => e.kind === 'type')
        return entry ? [uriTermToLocation(uriTerm.create(entry.doc.uri, entry.term))] : []
    }
    return []
}

/** 目标项的符号类别：优先用阶段 3 解析出来的 kind，其次用 AST 标注的 semanticType */
function symbolKind(document: MercuryDocument, term: Term): string | undefined {
    return document.resolved?.get(term)?.[0]?.kind ?? term.semanticType
}

/** kind 过滤：同名但类别不同（pred/func/constructor/type/inst/mode）的符号互不干扰 */
function matchesKind(kind: string | undefined, entry: SymbolEntry): boolean {
    return !kind || entry.kind === kind
}

/** term → 符号条目：优先读阶段 3 落盘的 doc.resolved，其次按 term 身份找 */
function resolvedEntry(document: MercuryDocument, term: Term): SymbolEntry | undefined {
    return document.resolved?.get(term)?.[0]
}

/** 按模块限定名找模块所在文档 */
export function findModuleDoc(services: MercuryServices, term: Term): MercuryDocument | undefined {
    const name = moduleQualifiedName(term)
    const short = name.split('.').pop() ?? name
    return services.documents.all.find(doc => {
        const moduleName = doc.moduleName
        return !!moduleName && (moduleName === name || moduleName === short || moduleName.split('.').pop() === short)
    })
}

/**
 * 记录语法 `^` 处的字段说明符 → field access function 定义。
 * Mercury 参考手册 §2.15.2：field specifier `field/N` 展开为
 * `field/(N+1)`（selection）与 `'field :='/(N+2)`（update）。
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
    const result: uriTerm[] = []
    const seen = new Set<string>()
    const push = (uri: URI, def: Term) => {
        const key = `${uri.toString()}:${def.token.line}:${def.token.col}`
        if (seen.has(key)) return
        seen.add(key)
        result.push(uriTerm.create(uri, def))
    }
    for (const q of queries) {
        // 本文件的定义 + 其它模块 interface 段导出的同名项，直接查全局符号表
        for (const entry of services.index.get(q.name)) {
            if (entry.doc !== document && !entry.exported) continue
            const def = entry.term
            if (semanticArityOf(def) !== q.arity) continue
            if (!q.kinds.includes(entry.kind) || !q.kinds.includes(def.semanticType ?? '')) continue
            push(entry.doc.uri, def)
        }
    }
    return stream(result)
}

export interface uriTerm {
    uri: URI,
    term: Term
}
export namespace uriTerm {
    export function create(uri: URI, term: Term): uriTerm {
        return { uri, term }
    }
}
export function uriTermToLocation(uriTerm: uriTerm) {
    return Location.create(
        uriTerm.uri.toString(),
        termTokenRange(uriTerm.term)
    )
}

export function findDefTerms(services: MercuryServices, params: uriTerm): Stream<uriTerm> {
    const { term, uri } = params
    const document = services.documents.getOrCreateDocument(uri)!
    if (term.fieldAccess) return findFieldAccessDefinitions(services, term, document)

    switch (term.semanticType) {
        case 'variable': {
            // 变量只在所在 clause 里解析
            const node = term.clause?.varMap.get(term.name)[0]
            return node ? stream([uriTerm.create(uri, node)]) : stream([])
        }
        case 'module': {
            const doc = findModuleDoc(services, term)
            const moduleTerm = doc?.moduleTerm
            return doc && moduleTerm ? stream([uriTerm.create(doc.uri, moduleTerm)]) : stream([])
        }
        default: {
            // 解析结果由阶段 3 落盘；第一个条目就是定义（声明兜底的活也已在那里做完）
            const entry = resolvedEntry(document, term)
            if (!entry || !matchesKind(symbolKind(document, term), entry)) return stream([])
            return stream([uriTerm.create(entry.doc.uri, entry.term)])
        }
    }
}

export async function findAtTextDocumentPositionTerm(services: MercuryServices, params: TextDocumentPositionParams) {
    let pos = params.position;
    let uri = URI.parse(params.textDocument.uri);
    while (!services.documents.getOrCreateDocument(uri)) {
        await sleep(100);
    }
    let document = services.documents.getOrCreateDocument(uri)!
    let rootNode = document.parseResult.value
    let term = search(rootNode, pos);
    if (term) return {
        uri,
        term
    }
}
