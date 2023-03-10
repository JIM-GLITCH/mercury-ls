import { DocumentSymbol, DocumentSymbolParams, SymbolInformation, SymbolKind } from 'vscode-languageserver'
import { nameArity, showNameArity, sleep } from './utils'
import { documentMap } from './globalSpace'
import { termRange, StartEndTokenToRange } from './term'
import { stream } from './stream'

export async function DocumentSymbolProvider(params: DocumentSymbolParams) {
    let uri  = params.textDocument.uri;
    let document ;
    while( !(document = documentMap.get(uri))){
        await sleep(100);
    }
    let symbols :DocumentSymbol[]=[];
    
    let module = stream(document.moduleDefMap.values()).head()
    if(module){
        let range = termRange(module);
        symbols.push({
            name: module.name,
            kind: SymbolKind.Module,
            range: termRange(module),
            selectionRange: range
        })
    }

    for (const [name ,funcTerms] of document.funcDefMap.entriesGroupedByKey()) {
        let children:DocumentSymbol[] = []
        for (const funcTerm of funcTerms ) {
            for (const [varName,varTerms] of funcTerm.clause.varmap.entriesGroupedByKey()) {
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
        symbols.push({
            name: showNameArity(funcTerm),
            kind:SymbolKind.Operator,
            range: StartEndTokenToRange(funcTerms[0].clause!.startToken,funcTerms[funcTerms.length-1].clause!.endToken),
            selectionRange: termRange(funcTerm),
            children:children,
        })
    }

    for (const [name ,predTerms] of document.predDefMap.entriesGroupedByKey()) {
        let children:DocumentSymbol[] = []
        for (const funcTerm of predTerms) {
            for (const [varName,varTerms] of funcTerm.clause.varmap.entriesGroupedByKey()) {
                let varRange  = termRange(varTerms[0]);
                children.push({
                    name: varName,
                    kind: SymbolKind.Variable,
                    range: varRange,
                    selectionRange: varRange
                })	
            } 
        }
        let funcTerm = predTerms[0];
        symbols.push({
            name: showNameArity(funcTerm),
            kind:SymbolKind.Function,
            range: StartEndTokenToRange(predTerms[0].clause.startToken,predTerms[predTerms.length-1].clause!.endToken),
            selectionRange: termRange(funcTerm),
            children:children,
        })
    }
    return symbols;
} 
