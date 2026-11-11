import { Hover, HoverParams, MarkupContent } from 'vscode-languageserver'
import { semanticArityOf, semanticNameArityOf } from './utils'
import { search, termRange } from './term'
import { URI } from 'vscode-uri'
import { merTypeToString } from './document-type'
import type { MercuryServices } from './services'

export async function HoverProvider(services: MercuryServices, params: HoverParams): Promise<Hover | undefined> {
    let pos = params.position;
    let uri = params.textDocument.uri;
    let doc = services.documents.getOrCreateDocument(URI.parse(uri));
    if (!doc) return undefined
    let term = search(doc.parseResult.value, pos)
    if (!term) return undefined

    // 名字 callee（如 p）与应用项（如 p(1)）要区分开：
    // - 展示用的名字/元数/签名按“容器应用项”取，避免 callee 被显示成 p/0
    // - 类型按“实际命中的 term”取：callee → 函数/构造子/谓词签名类型，应用项 → 结果类型
    const foundTerm = term
    const displayTerm = term.calleeOf ?? term
    const displayName = displayTerm.qualifiedName ?? displayTerm.name
    let header: string
    if (displayTerm.semanticType) {
        switch (displayTerm.semanticType) {
            case 'func':
            case 'pred':
            case 'type':
            case "inst":
            case "mode":
            case "constructor":
            case "typeclass":
            case "instance":
            case "pragma":
            case "operator":
                header = `(${displayTerm.semanticType}) ${displayName}/${semanticArityOf(displayTerm)}`
                break;
            case 'module':
            case "variable":
            case "mutable":
            case "determinism":
                header = `(${displayTerm.semanticType}) ${displayName}`
                break;
            default:
                header = `(${displayTerm.semanticType}) ${displayName}`
        }
    }
    else {
        switch (displayTerm.syntaxType) {
            case 'string':
            case 'variable':
            case 'integer':
            case 'float':
            case 'implementation_defined':
                header = displayTerm.name;
                break;
            case 'atom':
                header = semanticNameArityOf(displayTerm);
                break;
            default:
                header = displayTerm.name;
                break;
        }
    }

    // 类型展示：优先用命中 term 的推断类型（精确区分 p 与 p(1)），再补阶段 3 解析出的签名
    let typeStr: string | undefined
    if (foundTerm.semanticType !== 'module') {
        const inferred = doc.inferred?.get(foundTerm)
        if (inferred?.type) {
            typeStr = `type ${merTypeToString(inferred.type)}`
        }
        // 只认阶段 3 的解析结果；没有就是没解析出来，不再按名字猜
        const signature = doc.resolved?.get(displayTerm)?.find(e => e.signature)?.signature
        if (signature && (signature.kind === 'func' || signature.kind === 'pred' || signature.kind === 'constructor')) {
            const args = signature.args.map(merTypeToString).join(', ')
            const head = args ? `${displayName}(${args})` : displayName
            const modes = signature.args.map(() => 'in').join(', ')
            let sigStr: string
            if (signature.kind === 'constructor') {
                sigStr = `type ${head} = ${merTypeToString(signature.result)}`
            } else if (signature.kind === 'func') {
                sigStr = `type ${head} = ${signature.result ? merTypeToString(signature.result) : '?'}\n`
                    + `mode ${displayName}(${modes}) = (out)`
            } else {
                sigStr = `type ${head}\nmode ${displayName}(${modes})`
            }
            typeStr = typeStr ? `${typeStr}\n${sigStr}` : sigStr
        } else if (signature) {
            const sigStr = `type ${merTypeToString(signature)}`
            typeStr = typeStr ? `${typeStr}\n${sigStr}` : sigStr
        }
    }

    const code = [header, typeStr].filter(s => s !== undefined).join('\n')

    return {
        contents: {
            kind: "markdown",
            value: [
                '```mercury',
                code,
                '```'
            ].join('\n')
        } as MarkupContent,
        range: termRange(foundTerm)
    } as Hover
}
