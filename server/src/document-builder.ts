import { CancellationToken, FormattingOptions } from 'vscode-languageserver'
import { DocumentState, MercuryDocument, mercuryDocumentFactory, mercuryDocuments } from './documents'
import { interruptAndCheck } from './promise-util'
import { MultiMap } from './multimap'
import { URI } from 'vscode-uri'
import { validator } from './document-validator'
import { visitor } from './document-visitor'
import { moduleMap } from './globalSpace'
import { equalQualified, moduleManager } from './document-moduleManager'
import { linker } from './linker'
import { stream } from './stream'
export type DocumentBuildListener = (built: MercuryDocument[], cancelToken: CancellationToken) => void | Promise<void>
export type DocumentUpdateListener = (changed: URI[], deleted: URI[]) => void

export class DefaultDocumentBuilder{
    buildPhaseListener:MultiMap<DocumentState,DocumentBuildListener>= new MultiMap()
    async build(documents:MercuryDocument[],cancelToken = CancellationToken.None){
        await this.buildDocuments(documents,cancelToken);
    }
    async buildDocuments(documents: MercuryDocument[], cancelToken: CancellationToken) {
        // 0. Parse content
        //  parsing is done initially for each document, but
        //  re-parsing after changes reported by the client might have been canceled by subsequent changes, so re-parse now
        await this.runCancelable(documents, DocumentState.Parsed, cancelToken, doc =>
            mercuryDocumentFactory.update(doc)
            );
            await this.runCancelable(documents,DocumentState.Visited,cancelToken,doc=>{
                visitor.visit(doc,cancelToken);
                let visitResult = doc.visitResult!
                if(visitResult.module){
                    moduleManager.set(visitResult.module,doc);
            }
        })
        // 1. Index content
        // await this.runCancelable(documents, DocumentState.IndexedContent, cancelToken, doc =>
        //     indexManager.updateContent(doc, cancelToken)
        // );
        // //  2 compute scopes
        // await this.runCancelable(documents,DocumentState.ComputedScopes,cancelToken,doc=>{
        //     this.computeScopes(doc,cancelToken);
        // })
        // 3 linking
        await this.runCancelable(documents,DocumentState.Linked,cancelToken,doc=>{
            linker.link(doc,cancelToken);
        })
        // // 4. index references 
        // await this.runCancelable(documents,DocumentState.IndexedReferences,cancelToken,doc=>{
            //     indexManager.updateReferences(doc,cancelToken);
        // })
        // 5 validate 
        await this.runCancelable(documents,DocumentState.Linked,cancelToken,doc=>{
            this.validate(doc,cancelToken);
        })
    }
    async update(changed: URI[], deleted: URI[], cancelToken = CancellationToken.None): Promise<void> {
        let deletedDocuments = []
        for (const deletedUri of deleted) {
            // Note : this deletedDocument should be the last reference to detedDocument
            // to stay away from memory leak
            let deletedDocument = mercuryDocuments.deleteDocument(deletedUri);
            if(deletedDocument){
                moduleManager.delete(deletedDocument);
                deletedDocuments.push(deletedDocument)
            }
        }
        for (const changedUri of changed) {
            mercuryDocuments.invalidateDocument(changedUri)
        }
        await interruptAndCheck(cancelToken);
        let changedDocuments = changed.map(e=>mercuryDocuments.getOrCreateDocument(e))
        let affectedDocuments = this.collectDocuments(changedDocuments,deletedDocuments)
        await this.buildDocuments(affectedDocuments,cancelToken)
    }
    collectDocuments(changedDocuments: MercuryDocument[], deletedDocuments:MercuryDocument[]) {
        let docSet = stream(changedDocuments,deletedDocuments)
        .map(doc=>doc.importedByDocs)
        .flat()
        .concat(changedDocuments)
        .toSet()

        return Array.from(docSet)
    }
    async runCancelable(documents: MercuryDocument[], targetState: DocumentState, cancelToken: CancellationToken, callback: (doc: MercuryDocument) => any) {
        let filtered = documents.filter(e=>e.state<targetState);
        for (const document of filtered) {
            await interruptAndCheck(cancelToken);
            await callback(document)
        }
        await this.notifyBuildPhase(filtered ,targetState,cancelToken);
    }
    async notifyBuildPhase(documents: MercuryDocument[], state: DocumentState, cancelToken: CancellationToken) {
        if(documents.length===0){
            // Don;t notify when no document has been processed
            return 
        }
        let listeners = this.buildPhaseListener.get(state);
        for (const listener of listeners) {
            await interruptAndCheck(cancelToken);
            await listener(documents,cancelToken)
        }
    }

    async validate(document:MercuryDocument,cancelToken:CancellationToken){
        let diagnostics = await validator.validateDocument(document,cancelToken);
        document.diagnostics = diagnostics;
        document.state = DocumentState.Validated
    }
}
export let documentBuilder = new DefaultDocumentBuilder()


function equalURI(a?: URI|string, b?: URI|string): boolean {
    return a?.toString() ===  b?.toString()
}

