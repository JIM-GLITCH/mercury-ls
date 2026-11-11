import { Location, ReferenceParams } from 'vscode-languageserver'
import { equalQualified, semanticArityOf, sleep } from './utils'
import { FieldAccessInfo, Term, search, termRange } from './term'
import { MercuryDocument } from './document-manager'
import { URI } from 'vscode-uri'
import type { MercuryServices } from './services'

export async function ReferenceProvider(services: MercuryServices, params: ReferenceParams): Promise<Location[]> {
    let uri = params.textDocument.uri
    let pos = params.position
    let document: MercuryDocument | undefined
    while (!(document = services.documents.getOrCreateDocument(URI.parse(uri)))) {
        await sleep(100)
    }
    let term = search(document.parseResult.value, pos)
    if (!term) return []

    // 目标符号所属模块：引用带限定名则取其限定，否则为所在文档的模块
    const termModule: Term | undefined = term.qualified ?? document.moduleTerm
    const includeDeclaration = params.context?.includeDeclaration ?? false
    // 只列同类别符号的引用：pred / func / constructor / type / inst / mode 互不串
    const kind = symbolKind(document, term)

    switch (term.semanticType) {
        case 'variable': {
            // 变量引用只在同一 clause 里
            return (term.clause?.varMap.get(term.name) ?? []).map(refTerm => ({
                uri,
                range: termRange(refTerm),
            }))
        }
        case 'module': {
            // 模块名的显式出现（import/限定词/end_module）不做可见性过滤
            const refs: Location[] = []
            collectReferences(services, term, undefined, includeDeclaration, 'module', refs, new Set())
            return refs
        }
        default: {
            const refs: Location[] = []
            const seen = new Set<string>()
            collectReferences(services, term, termModule, includeDeclaration, kind, refs, seen)
            collectFieldRefs(services, term, termModule, includeDeclaration, kind, refs, seen)
            return refs
        }
    }
}

/** 项所属符号类别：优先用阶段 3 解析出的 kind，其次用 AST 标注的 semanticType */
function symbolKind(document: MercuryDocument, term: Term): string | undefined {
    return document.resolved?.get(term)?.[0]?.kind ?? term.semanticType
}

/** 引用项 = 标注过 semanticType 的项 ∪ 已解析的项（数据位置的构造子/函数调用也会被解析到） */
function referenceTerms(doc: MercuryDocument): Term[] {
    const seen = new Set<Term>()
    const out: Term[] = []
    const add = (t: Term) => {
        if (seen.has(t)) return
        seen.add(t)
        out.push(t)
    }
    for (const t of doc.references ?? []) add(t)
    for (const t of doc.resolved?.keys() ?? []) add(t)
    return out
}

/** 引用的可见性过滤：限定引用必须限定到目标模块；非限定引用只在同一模块或 import 了它的文档里 */
function visibleRef(refTerm: Term, termModule: Term | undefined, doc: MercuryDocument): boolean {
    if (!termModule) return true
    const q = refTerm.qualified
    if (q) return equalQualified(q, termModule)
    const module = doc.moduleTerm
    if (!module) return true
    if (equalQualified(module, termModule)) return true
    return (doc.importModules ?? []).some(imp => equalQualified(imp, termModule))
}

function pushRef(refs: Location[], seen: Set<string>, doc: MercuryDocument, refTerm: Term) {
    const uri = doc.uri.toString()
    const range = termRange(refTerm)
    const key = `${uri}:${range.start.line}:${range.start.character}`
    if (seen.has(key)) return
    seen.add(key)
    refs.push({ uri, range })
}

/**
 * 直接遍历阶段 3 落盘的 doc.references / doc.resolved：
 * 引用项与它解析到的符号已经确定，不需要再匹配候选。
 */
function collectReferences(
    services: MercuryServices, term: Term, termModule: Term | undefined,
    includeDeclaration: boolean, kind: string | undefined,
    refs: Location[], seen: Set<string>,
) {
    for (const doc of services.documents.all) {
        for (const refTerm of referenceTerms(doc)) {
            if (refTerm.name !== term.name) continue
            if (semanticArityOf(refTerm) !== semanticArityOf(term)) continue
            if (kind && symbolKind(doc, refTerm) !== kind) continue
            if (!visibleRef(refTerm, termModule, doc)) continue
            const resolved = doc.resolved?.get(refTerm)?.[0]
            if (resolved?.term === refTerm && !includeDeclaration) continue
            // callee 的容器若是声明头（带 semanticType），它本身就是声明，不应在
            // includeDeclaration=false 时当作引用列出（应用项的容器 semanticType 为空，不受影响）
            if (!includeDeclaration && refTerm.calleeOf?.semanticType) continue
            pushRef(refs, seen, doc, refTerm)
        }
    }
}

// 语法糖 `^` 字段说明符：与展开出来的 field access function 名字、元数都不同，
// 按名 + 元数找不到，这里按派生关系补上（派生规则见 term.ts 的 FieldAccessInfo）
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
function collectFieldRefs(
    services: MercuryServices, term: Term, termModule: Term | undefined,
    includeDeclaration: boolean, kind: string | undefined,
    refs: Location[], seen: Set<string>,
) {
    const base = fieldRefBase(term)
    if (!base) return
    for (const doc of services.documents.all) {
        for (const refTerm of referenceTerms(doc)) {
            if (refTerm.name !== base) continue
            const fs: FieldAccessInfo | undefined = refTerm.fieldAccess
            if (!fs || fs.base !== base) continue
            if (!matchesFieldRef(term, fs)) continue
            if (kind && symbolKind(doc, refTerm) !== kind) continue
            if (!visibleRef(refTerm, termModule, doc)) continue
            const resolved = doc.resolved?.get(refTerm)?.[0]
            if (resolved?.term === refTerm && !includeDeclaration) continue
            if (!includeDeclaration && refTerm.calleeOf?.semanticType) continue
            pushRef(refs, seen, doc, refTerm)
        }
    }
}
