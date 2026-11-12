import {
    CompletionItem, CompletionItemKind, CompletionParams,
    MarkupKind, Position, Range,
} from 'vscode-languageserver'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { URI } from 'vscode-uri'
import { moduleQualifiedName } from './document-moduleManager'
import { merTypeToString } from './document-type'
import type { MercuryServices } from './services'
import type { Term } from './term'
import { semanticArityOf } from './utils'

/** completionResolve 用来补出签名的载荷（只放可序列化的数据，不放 Term） */
export interface CompletionData {
    moduleName: string
    name: string
    arity: number
}

type Qualifier = {
    moduleName: string   // `.` 前方的 token，如 array / std.array
    fragment: string     // `.` 之后已经敲出的前缀
    dotOffset: number    // `.` 在全文里的 offset
}

/**
 * 从光标所在行截取 `module.` / `module.frag`：`.` 前方的 token 按模块限定名解析。
 * 只看原始文本，不依赖 AST —— 刚敲下 `.` 时文档正在重建，AST 往往是过期/残缺的。
 */
export function qualifierBeforeDot(textDocument: TextDocument, position: Position): Qualifier | undefined {
    const text = textDocument.getText()
    const lineStart = textDocument.offsetAt({ line: position.line, character: 0 })
    const cursor = textDocument.offsetAt(position)
    const beforeCursor = text.slice(lineStart, cursor)
    // 声明行/注释里的 `.` 是子句终止符或普通标点，不是限定符
    const trimmed = beforeCursor.trimStart()
    if (trimmed.startsWith(':-') || trimmed.startsWith('%')) return undefined
    // 字符串字面量内部也不补全
    let quotes = 0
    for (let i = 0; i < beforeCursor.length; i++) {
        if (beforeCursor[i] === '"' && beforeCursor[i - 1] !== '\\') quotes++
    }
    if (quotes % 2 === 1) return undefined
    const m = /([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.([A-Za-z_][A-Za-z0-9_]*)?$/.exec(beforeCursor)
    if (!m) return undefined
    const moduleName = m[1]
    return {
        moduleName,
        fragment: m[2] ?? '',
        dotOffset: lineStart + m.index + moduleName.length,
    }
}

function completionKind(term: Term): CompletionItemKind {
    switch (term.semanticType) {
        case 'func':
        case 'pred': return CompletionItemKind.Function
        case 'type': return CompletionItemKind.Class
        case 'constructor': return CompletionItemKind.Constructor
        case 'typeclass': return CompletionItemKind.Interface
        case 'instance': return CompletionItemKind.Class
        case 'inst':
        case 'mode': return CompletionItemKind.Property
        case 'module': return CompletionItemKind.Module
        default: return CompletionItemKind.Text
    }
}

/** 用已收集的 func/pred 签名给出补全项的 detail */
function signatureOf(services: MercuryServices, name: string, arity: number): string | undefined {
    const fi = services.exportManager.lookupFunc(name, arity)
    if (!fi) return undefined
    const args = fi.argTypes.map(merTypeToString).join(', ')
    return fi.resultType
        ? `type ${name}(${args}) = ${merTypeToString(fi.resultType)}`
        : `type ${name}(${args})`
}

/** `parent.` 处的下一级子模块名（如 `std.array.` 之前敲 `std.`） */
function submoduleNames(services: MercuryServices, moduleName: string): string[] {
    const prefix = moduleName + '.'
    const names = new Set<string>()
    for (const doc of services.documents.all) {
        const mod = doc.visitResult?.module
        if (!mod) continue
        const full = moduleQualifiedName(mod)
        if (!full.startsWith(prefix)) continue
        const next = full.slice(prefix.length).split('.')[0]
        if (next) names.add(next)
    }
    return [...names]
}

/**
 * 敲下 `.`（或手动触发 completion）时，把 `.` 前方的 token 当作模块名，
 * 补全该模块 interface 段导出的符号；不是已知模块/子模块前缀时返回空，
 * 避免 `A.`（A 是变量）之类的位置弹出无关项。
 */
export async function CompletionProvider(
    services: MercuryServices, params: CompletionParams,
): Promise<CompletionItem[]> {
    const uri = params.textDocument.uri
    const parsed = URI.parse(uri)
    // 编辑器里打开的文档优先（增量同步后文本是最新的），否则回退到已建索引的文档；
    // 不去读文件系统，避免补全请求被磁盘 IO / 不存在的临时 URI 拖住
    const indexed = services.documents.hasDocument(parsed)
        ? services.documents.getOrCreateDocument(parsed)
        : undefined
    const textDocument = services.textDocuments.get(uri) ?? indexed?.textDocument
    if (!textDocument) return []
    const q = qualifierBeforeDot(textDocument, params.position)
    if (!q) return []

    const exported = services.exportManager.getByModule(q.moduleName)
    // 全局索引尚未收录当前文档时（例如刚打开尚未 build），用本文件的 exports 兜底
    if (exported.length === 0) {
        const own = indexed?.visitResult
        if (own?.module && moduleQualifiedName(own.module) === q.moduleName) {
            for (const t of own.exports.values()) exported.push(t)
        }
    }
    const submodules = submoduleNames(services, q.moduleName)
    if (exported.length === 0 && submodules.length === 0) return []

    // 只替换 `.` 之后已输入的部分，保证 VS Code 按 fragment 过滤且不会吃掉 `.`
    const range: Range = {
        start: textDocument.positionAt(q.dotOffset + 1),
        end: params.position,
    }
    const fragment = q.fragment.toLowerCase()
    const seen = new Set<string>()
    const items: CompletionItem[] = []
    const add = (label: string, kind: CompletionItemKind, detail: string, data?: CompletionData) => {
        if (fragment && !label.toLowerCase().startsWith(fragment)) return
        if (seen.has(label)) return
        seen.add(label)
        items.push({ label, kind, detail, data, sortText: label, textEdit: { range, newText: label } })
    }
    for (const t of exported) {
        const arity = semanticArityOf(t)
        add(t.name, completionKind(t),
            signatureOf(services, t.name, arity) ?? `${t.name}/${arity} · ${q.moduleName}`,
            { moduleName: q.moduleName, name: t.name, arity })
    }
    for (const name of submodules) {
        add(name, CompletionItemKind.Module, `module ${q.moduleName}.${name}`)
    }
    return items
}

/** 选中补全项后补上签名文档 */
export function CompletionResolve(services: MercuryServices, item: CompletionItem): CompletionItem {
    const data = item.data as CompletionData | undefined
    if (!data) return item
    const sig = signatureOf(services, data.name, data.arity)
    if (sig) {
        item.documentation = {
            kind: MarkupKind.Markdown,
            value: ['```mercury', sig, '```', `module ${data.moduleName}`].join('\n'),
        }
    }
    return item
}
