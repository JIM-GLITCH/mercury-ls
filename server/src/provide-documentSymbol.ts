import { CancellationToken, DocumentSymbol, DocumentSymbolParams, SymbolKind } from 'vscode-languageserver'
import { semanticNameArityOf, sleep } from './utils'
import { termRange, StartEndTokenToRange, Term } from './term'
import { URI } from 'vscode-uri'
import type { MercuryServices } from './services'
import type { SemanticType } from './document-index'
import { checkCancel } from './promise-util'
import { MultiMap } from './multimap'

export async function DocumentSymbolProvider(services: MercuryServices, params: DocumentSymbolParams, cancelToken: CancellationToken) {
    const uri = URI.parse(params.textDocument.uri)
    let document = services.documents.getOrCreateDocument(uri)
    // doc.resolved 由阶段 3 落盘，等它就绪即可，无需再构造索引视图
    while (!document?.resolved) {
        await sleep(10)
        await checkCancel(cancelToken)
        document = services.documents.getOrCreateDocument(uri)
    }
    const symbols: DocumentSymbol[] = []

    const module = document.moduleTerm
    if (module) {
        const range = termRange(module)
        symbols.push({
            name: module.name,
            kind: SymbolKind.Module,
            range,
            selectionRange: range,
        })
    }

    // doc.resolved 里键 == entry.term 的就是本文件登记过的定义/声明项
    const definitions: Term[] = []
    for (const [term, entries] of document.resolved!) {
        if (entries[0]?.term === term) definitions.push(term)
    }
    const map = new MultiMap<string, Term>(
        definitions.map(x => [semanticNameArityOf(x), x] as [string, Term]))
    for (const [displayName, funcTerms] of map.entriesGroupedByKey()) {
        let subFuncs: DocumentSymbol[] = []
        for (const funcTerm of funcTerms) {
            let children: DocumentSymbol[] = []
            for (const [varName, varTerms] of funcTerm.clause?.varMap.entriesGroupedByKey() ?? []) {
                let varRange = termRange(varTerms[0])
                children.push({
                    name: varName,
                    kind: SymbolKind.Variable,
                    range: varRange,
                    selectionRange: varRange,
                })
            }
            let range = termRange(funcTerm.clause!)
            subFuncs.push({
                name: displayName,
                kind: typeToKind(funcTerm.semanticType),
                selectionRange: funcTerm.range,
                children,
                range,
            })
        }
        if (subFuncs.length == 1) {
            symbols.push(subFuncs[0])
        } else {
            let funcTerm = funcTerms[0]
            let range = StartEndTokenToRange(funcTerms[0].clause!.startToken, funcTerms[funcTerms.length - 1].clause!.endToken)
            symbols.push({
                name: displayName,
                kind: typeToKind(funcTerm.semanticType),
                range,
                selectionRange: termRange(funcTerm),
                children: subFuncs,
            })
        }
    }
    return symbols
}

function typeToKind(type: SemanticType | undefined): SymbolKind {
    switch (type) {
        case 'string':
            return SymbolKind.String
        case 'func':
            return SymbolKind.Function
        case 'pred':
            return SymbolKind.Boolean
        case 'type':
            return SymbolKind.Struct
        case 'constructor':
            return SymbolKind.EnumMember
        case 'fieldname':
            return SymbolKind.Property
        case 'module':
            return SymbolKind.Module
        case 'typeclass':
            return SymbolKind.Interface
        case 'instance':
            return SymbolKind.Class
        case 'pragma':
            return SymbolKind.Property
        case 'operator':
            return SymbolKind.Operator
        case 'mutable':
            return SymbolKind.Variable
        case 'determinism':
            return SymbolKind.EnumMember
        case 'variable':
            return SymbolKind.Variable
        case 'float':
            return SymbolKind.Number
        case 'integer':
            return SymbolKind.Number
        case 'conditional':
            return SymbolKind.Function
        case 'record':
            return SymbolKind.Object
        case 'apply':
            return SymbolKind.Function
        case 'lambda':
            return SymbolKind.Function
        case 'unification':
            return SymbolKind.Variable
        case 'explicitType':
            return SymbolKind.Object
        default:
            return SymbolKind.Object
    }
}
