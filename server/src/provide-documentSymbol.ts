import { DocumentSymbol, DocumentSymbolParams, SymbolInformation, SymbolKind } from 'vscode-languageserver'
import { nameArity, sleep } from './utils'
import { docsMap } from './globalSpace'
import { termRange, tokenToRange } from './term'

export async function DocumentSymbolProvider(params: DocumentSymbolParams) {
    let uri  = params.textDocument.uri;
    let document ;
    while( !(document = docsMap.get(uri))){
        await sleep(100);
    }
    let symbols :DocumentSymbol[]=[];
    for (const [name ,funcTerms] of document.funcDefMap.map) {
        let children:DocumentSymbol[] = []
        for (const funcTerm of funcTerms ) {
            for (const [varName,varTerms] of funcTerm.clause.varmap.map) {
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
            name: nameArity(funcTerm),
            kind:SymbolKind.Operator,
            range: tokenToRange(funcTerms[0].clause!.startToken,funcTerms[funcTerms.length-1].clause!.endToken),
            selectionRange: termRange(funcTerm),
            children:children,
        })
    }

    for (const [name ,predTerms] of document.predDefMap.map) {
        let children:DocumentSymbol[] = []
        for (const funcTerm of predTerms) {
            for (const [varName,varTerms] of funcTerm.clause.varmap.map) {
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
            name: nameArity(funcTerm),
            kind:SymbolKind.Function,
            range: tokenToRange(predTerms[0].clause.startToken,predTerms[predTerms.length-1].clause!.endToken),
            selectionRange: termRange(funcTerm),
            children:children,
        })
    }
    return symbols;
} 
