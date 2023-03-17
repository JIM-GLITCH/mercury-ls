import { CancellationToken, DocumentSymbol, DocumentSymbolParams, SymbolInformation, SymbolKind } from 'vscode-languageserver'
import { nameArity, showNameArity, sleep } from './utils'
import { termRange, StartEndTokenToRange } from './term'
import { stream } from './stream'
import { DefaultMercuryDocuments, mercuryDocuments } from './document-manager'
import { URI } from 'vscode-uri'
import { SemanticType } from './document-visitor'
import { delayNextTick, interruptAndCheck } from './promise-util'

export async function DocumentSymbolProvider(params: DocumentSymbolParams,cancelToken:CancellationToken) {
    let uri  = params.textDocument.uri;
    let document =mercuryDocuments.getOrCreateDocument(URI.parse(uri))
    let symbols :DocumentSymbol[]=[];
    while(!document.visitResult)
        await interruptAndCheck(cancelToken)
    let visitResult = document.visitResult
    let module = visitResult.module;
    if(module){
        let range = termRange(module);
        symbols.push({
            name: module.name,
            kind: SymbolKind.Module,
            range: termRange(module),
            selectionRange: range
        })
    }
    let definition = document.visitResult.definition
    for (const [name ,funcTerms] of definition.entriesGroupedByKey()) {
        let children:DocumentSymbol[] = []
        for (const funcTerm of funcTerms ) {
            for (const [varName,varTerms] of funcTerm.clause?.varMap.entriesGroupedByKey()??[]) {
                let varRange  = termRange(varTerms[0]);
                children.push({
                    name: varName,
                    kind: SymbolKind.Variable,
                    range: varRange,
                    selectionRange: varRange
                })	
            } 
        }
        let funcTerm = funcTerms[0];
        let range= StartEndTokenToRange(funcTerms[0].clause!.startToken,funcTerms[funcTerms.length-1].clause!.endToken);

        symbols.push({
            name: showNameArity(funcTerm),
            kind:typeToKind(funcTerm.semanticType),
            range,
            selectionRange: termRange(funcTerm),
            children:children,
        })
    }
    return symbols;
} 
function typeToKind(type:SemanticType|undefined):SymbolKind{
    switch (type) {
        case 'string':
            return SymbolKind.String
        case 'func':
            return SymbolKind.Operator
        case 'pred':
            return SymbolKind.Function
        case 'type':
            return SymbolKind.TypeParameter
        case 'module':
            return SymbolKind.Module
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