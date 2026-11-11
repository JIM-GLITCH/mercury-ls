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
    const displayName = term.qualifiedName ?? term.name
    let header: string
    if (term.semanticType) {
        switch (term.semanticType) {
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
                header = `(${term.semanticType}) ${displayName}/${semanticArityOf(term)}`
                break;
            case 'module':
            case "variable":
            case "mutable":
            case "determinism":
                header = `(${term.semanticType}) ${displayName}`
                break;
            default:
                header = `(${term.semanticType}) ${displayName}`
        }
    }
    else {
        switch (term.syntaxType) {
            case 'string':
            case 'variable':
            case 'integer':
            case 'float':
            case 'implementation_defined':
                header = term.name;
                break;
            case 'atom':
                header = semanticNameArityOf(term);
                break;
            default:
                header = term.name;
                break;
        }
    }

    // 类型展示直接读阶段 3 落盘的解析结果：term → SymbolEntry.signature
    let typeStr: string | undefined
    if (term.semanticType !== 'module') {
        const resolved = doc.resolved?.get(term)?.[0]
        const signature = resolved?.signature
            ?? services.index.get(term.name).find(e => e.signature && e.arity === semanticArityOf(term))?.signature
        if (signature && (signature.kind === 'func' || signature.kind === 'pred' || signature.kind === 'constructor')) {
            const args = signature.args.map(merTypeToString).join(', ')
            const head = args ? `${term.name}(${args})` : term.name
            const modes = signature.args.map(() => 'in').join(', ')
            if (signature.kind === 'constructor') {
                typeStr = `type ${head} = ${merTypeToString(signature.result)}`
            } else if (signature.kind === 'func') {
                typeStr = `type ${head} = ${signature.result ? merTypeToString(signature.result) : '?'}\n`
                    + `mode ${term.name}(${modes}) = (out)`
            } else {
                typeStr = `type ${head}\nmode ${term.name}(${modes})`
            }
        } else if (signature) {
            typeStr = `type ${merTypeToString(signature)}`
        }
        if (!typeStr) {
            const inferred = doc.inferred?.get(term)
            if (inferred?.type) typeStr = `type ${merTypeToString(inferred.type)}`
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
        range: termRange(term)
    } as Hover
}
