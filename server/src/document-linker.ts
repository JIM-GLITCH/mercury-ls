import { CancellationToken, Diagnostic, DiagnosticSeverity } from 'vscode-languageserver'
import { MercuryDocument } from './document-manager'
import { stream } from './stream'
import { equalQualified, moduleManager } from './document-moduleManager'
import { label } from './document-visitor'
import { Term } from './term'
import { interruptAndCheck } from './promise-util'
import { MultiMap } from './multimap'

export interface Linker {
    /**
     * Links all cross-references within the specified document. The default implementation loads only target
     * elements from documents that are present in the `LangiumDocuments` service.
     *
     * @param document A LangiumDocument that shall be linked.
     * @param cancelToken A token for cancelling the operation.
     */
       link(document: MercuryDocument, cancelToken?: CancellationToken): Promise<void>;

    /**
    * Unlinks all references within the specified document and removes them from the list of `references`.
    *
    * @param document A LangiumDocument that shall be unlinked.
    */
    unlink(document: MercuryDocument): void;
   
}

export class DefaultLinker implements Linker{
    errors = [] as Diagnostic[]
    async link(document: MercuryDocument, cancelToken:CancellationToken ) {
        this.errors= []
        // let importedSymbolKeyValuePairs = stream(document.visitResult!.imports)
        //     .map(importTerm =>{
        //         let targetDoc = moduleManager.get(importTerm);
        //         if(!targetDoc)
        //             return undefined
        //         // keep information that which docs import targetDoc 
        //         // when targetDoc is changed or deleted, rebuild these docs
        //         targetDoc.importedByDocs.push(document)
        //         return targetDoc.visitResult!.exports
        //     })
        //     .nonNullable()
        //     .flat()
        // let importedSymbolMap = new MultiMap(importedSymbolKeyValuePairs)
        // loop:
        // for (const term of document.visitResult!.reference.values()) {
        //     await interruptAndCheck(cancelToken);
        //     let definition = document.visitResult!.definition
        //     // first search local scope 
        //     if(definition.has(term.name)){
        //         let definitionTerm = definition.get(term.name)[0]
        //         label(term,definitionTerm.semanticType!)
        //         continue loop;
        //     }
        //     this.addError(" undefined Term",term)
        // }
        //     // then search imported Scope
        //     if(importedSymbolMap.has(term.name)){
        //         for(const targetTerm of importedSymbolMap.get(term.name)){
        //             if(equalQualified(targetTerm, term)){
        //                 // term.definition = targetTerm
        //                 label(term,targetTerm.semanticType!)
        //                 continue loop;
                        
        //             }
        //         }
        //     }
        //     // if can't find definition， report error
        //     this.addError(" undefined Term",term)
        // }
        document.linkResult = {errors:this.errors}
    }   
    addError(msg: string, term: Term) {
        this.errors.push(Diagnostic.create(
            term.range,
            msg,
            DiagnosticSeverity.Error,
            undefined,
            "linker"
        ))
    }
    unlink(document: MercuryDocument): void {
        throw new Error('Method not implemented.')
    }
    
}
export let linker = new DefaultLinker()