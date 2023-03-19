import { CancellationToken, Disposable, FormattingOptions, WorkDoneProgressCreateRequest } from 'vscode-languageserver'
import { DocumentState, MercuryDocument, mercuryDocumentFactory, mercuryDocuments } from './document-manager'
import { interruptAndCheck } from './promise-util'
import { MultiMap } from './multimap'
import { URI } from 'vscode-uri'
import { validator } from './document-validator'
import { Visitor } from './document-visitor'
// import { moduleMap } from './globalSpace'
import { equalQualified, moduleManager } from './document-moduleManager'
import { linker } from './document-linker'
import { stream } from './stream'
import { connection, sendBarText as changClientBarText, sendMemoryUsage } from './server'
export type DocumentBuildListener = (built: MercuryDocument[], cancelToken: CancellationToken) => void | Promise<void>
export type DocumentUpdateListener = (changed: URI[], deleted: URI[]) => void

export class DefaultDocumentBuilder{

    buildPhaseListeners:MultiMap<DocumentState,DocumentBuildListener>= new MultiMap()
    async build(documents:MercuryDocument[],cancelToken:CancellationToken){
        await this.buildDocuments(documents,cancelToken);
    }
    async buildDocuments(documents: MercuryDocument[], cancelToken: CancellationToken) {
        // 0. Parse content
        //  parsing is done initially for each document, but
        //  re-parsing after changes reported by the client might have been canceled by subsequent changes, so re-parse now
        for (const doc of documents) {
            if(doc.state <DocumentState.Parsed){
                mercuryDocumentFactory.update(doc);
                doc.state = DocumentState.Parsed
                await interruptAndCheck((cancelToken))
            }
            if(doc.state <DocumentState.Visited){
                let visitor = new Visitor;
                await visitor.visit(doc,cancelToken);
                let visitResult = doc.visitResult!
                if(visitResult.module){
                    moduleManager.set(visitResult.module,doc);
                }
                doc.state = DocumentState.Visited;
                await interruptAndCheck((cancelToken))
            }
        }
        changClientBarText.linking()
        // 3. linking
        for (const doc of documents) {
            await linker.link(doc,cancelToken);
            doc.state = DocumentState.Linked
            await interruptAndCheck((cancelToken))
        }
        // 4.vlaidate  
        connection.sendNotification("$/statusBar/text","$(sync~spin)validating")
        for (const doc of documents) {
            await this.validate(doc,cancelToken);
            doc.state = DocumentState.Validated
            connection.sendDiagnostics({uri:doc.uri.toString(),diagnostics:doc.diagnostics??[]})
            await interruptAndCheck((cancelToken))
        }
        changClientBarText.Mercury()
    }
    async update(changed: URI[], deleted: URI[], cancelToken:CancellationToken): Promise<void> {
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
        changClientBarText.parsing()
        let changedDocuments = changed.map(uri=>mercuryDocuments.getOrCreateDocument(uri))
        let affectedDocuments = this.collectDocuments(changedDocuments,deletedDocuments)
        await this.buildDocuments(affectedDocuments,cancelToken)
    }
    collectDocuments(changedDocuments: MercuryDocument[], deletedDocuments:MercuryDocument[]) {
        let docSet = stream(changedDocuments,deletedDocuments)
        .map(doc=>doc.importedByDocs)
        .flat()
        .concat(changedDocuments)
        .concat(mercuryDocuments.all.filter(doc =>doc.state<DocumentState.Validated ))
        .map(doc =>{
            doc.state = Math.min(doc.state,DocumentState.Visited)
            return doc
        })
        .toSet()

        return Array.from(docSet)
    }

    async validate(document:MercuryDocument,cancelToken:CancellationToken){
        let diagnostics = await validator.validateDocument(document,cancelToken);
        document.diagnostics = diagnostics;
    }
}
export let documentBuilder = new DefaultDocumentBuilder()


function equalURI(a?: URI|string, b?: URI|string): boolean {
    return a?.toString() ===  b?.toString()
}

