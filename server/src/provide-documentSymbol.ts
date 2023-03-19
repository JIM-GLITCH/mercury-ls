import { CancellationToken, DocumentSymbol, DocumentSymbolParams, SymbolInformation, SymbolKind } from 'vscode-languageserver'
import { nameArity, showNameArity, sleep } from './utils'
import { termRange, StartEndTokenToRange, Term } from './term'
import { stream } from './stream'
import { DefaultMercuryDocuments, mercuryDocuments } from './document-manager'
import { URI } from 'vscode-uri'
import { SemanticType } from './document-visitor'
import { checkCancel } from './promise-util'
import { MultiMap } from './multimap'
type a=1;
export async function DocumentSymbolProvider(params: DocumentSymbolParams,cancelToken:CancellationToken) {
    let uri  = params.textDocument.uri;
    let document =mercuryDocuments.getOrCreateDocument(URI.parse(uri))
    let symbols :DocumentSymbol[]=[];
    while(!document.visitResult){
        await sleep(10)
        await checkCancel(cancelToken)
    }
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
    let definition = document.visitResult.definition;
    let KeyValuePairs = definition.values().map(x=>[x.nameArity,x] as [string ,Term]);
    let map  = new MultiMap(KeyValuePairs)
    for (const [nameArity,funcTerms] of map.entriesGroupedByKey()) {
        let subFuncs:DocumentSymbol[]=[] 
        for (const funcTerm of funcTerms ) {
            let children:DocumentSymbol[]=[] 
            for (const [varName,varTerms] of funcTerm.clause?.varMap.entriesGroupedByKey()??[]) {
                let varRange  = termRange(varTerms[0]);
                children.push({
                    name: varName,
                    kind: SymbolKind.Variable,
                    range: varRange,
                    selectionRange: varRange
                })	
            }
            let range = termRange(funcTerm.clause!)
            subFuncs.push({
                name: nameArity,
                kind: typeToKind(funcTerm.semanticType),
                selectionRange: funcTerm.range,
                children,
                range
            }) 
        }
        if(subFuncs.length==1){
            symbols.push(subFuncs[0])
        }
        else{
            let funcTerm = funcTerms[0];
            let range= StartEndTokenToRange(funcTerms[0].clause!.startToken,funcTerms[funcTerms.length-1].clause!.endToken);
            symbols.push({
                name: nameArity,
                kind:typeToKind(funcTerm.semanticType),
                range,
                selectionRange: termRange(funcTerm),
                children:subFuncs,
            })            
        }
    }
    return symbols;
} 
function typeToKind(type:SemanticType|undefined):SymbolKind{
    switch (type) {
        case 'string':
            return SymbolKind.String
        case 'func':
            return SymbolKind.Function
        case 'pred':
            return SymbolKind.Boolean
        case 'type':
            return SymbolKind.Struct
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