import { CancellationToken } from 'vscode-languageserver'
import { DocumentState, MercuryDocument } from './document-manager'
import { interruptAndCheck } from './promise-util'
import { MultiMap } from './multimap'
import { URI } from 'vscode-uri'
import { Visitor } from './document-visitor'
import { stream } from './stream'
import { orderByImports, scanHeader } from './document-order'
import type { MercuryServices } from './services'

export type DocumentBuildListener = (built: MercuryDocument[], cancelToken: CancellationToken) => void | Promise<void>
export type DocumentUpdateListener = (changed: URI[], deleted: URI[]) => void

export class DefaultDocumentBuilder{

    constructor(protected readonly services: MercuryServices) {}

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
                this.services.documentFactory.update(doc);
                doc.state = DocumentState.Parsed
                await interruptAndCheck((cancelToken))
            }
        }
        // 0.5 按 import 依赖拓扑排序 visit 阶段：保证 import 目标的 (visit + exportManager.set)
        // 先于 importer 的 visit（跨模块推断据此从全局 exportManager 取到导入模块的类型/函数签名）
        const headers = new Map<MercuryDocument, { module?: string; imports: string[] }>()
        for (const doc of documents) headers.set(doc, scanHeader(doc.parseResult.value))
        const ordered = orderByImports(
            documents,
            d => headers.get(d)!.module,
            d => headers.get(d)!.imports,
        )
        for (const doc of ordered) {
            if(doc.state <DocumentState.Visited){
                let visitor = new Visitor(this.services);
                await visitor.visit(doc,cancelToken);
                let visitResult = doc.visitResult!
                if(visitResult.module){
                    this.services.moduleManager.set(visitResult.module,doc);
                }
                // 同步全局导出符号索引（linker 按名字取候选用）
                this.services.exportManager.set(doc);
                doc.state = DocumentState.Visited;
                await interruptAndCheck((cancelToken))
            }
        }
        this.services.client.setStatus('$(sync~spin)linking')
        // 3. linking
        for (const doc of documents) {
            await this.services.linker.link(doc,cancelToken);
            doc.state = DocumentState.Linked
            await interruptAndCheck((cancelToken))
        }
        // 4.vlaidate  
        this.services.client.setStatus('$(sync~spin)validating')
        for (const doc of documents) {
            await this.validate(doc,cancelToken);
            doc.state = DocumentState.Validated
            this.services.client.sendDiagnostics({uri:doc.uri.toString(),diagnostics:doc.diagnostics??[]})
            await interruptAndCheck((cancelToken))
        }
        this.services.client.setStatus('Mercury')
    }
    async update(changed: URI[], deleted: URI[], cancelToken:CancellationToken): Promise<void> {
        let deletedDocuments = []
        for (const deletedUri of deleted) {
            // Note : this deletedDocument should be the last reference to detedDocument
            // to stay away from memory leak
            let deletedDocument = this.services.documents.deleteDocument(deletedUri);
            if(deletedDocument){
                this.services.moduleManager.delete(deletedDocument);
                this.services.exportManager.delete(deletedDocument);
                deletedDocuments.push(deletedDocument)
            }
        }
        for (const changedUri of changed) {
            this.services.documents.invalidateDocument(changedUri)
        }
        await interruptAndCheck(cancelToken);
        this.services.client.setStatus('$(sync~spin)parsing')
        let changedDocuments = changed.map(uri=>this.services.documents.getOrCreateDocument(uri))
        let affectedDocuments = this.collectDocuments(changedDocuments,deletedDocuments)
        await this.buildDocuments(affectedDocuments,cancelToken)
    }
    collectDocuments(changedDocuments: MercuryDocument[], deletedDocuments:MercuryDocument[]) {
        let docSet = stream(changedDocuments,deletedDocuments)
        .map(doc=>doc.importedByDocs)
        .flat()
        .concat(changedDocuments)
        .concat(this.services.documents.all.filter(doc =>doc.state<DocumentState.Validated ))
        .map(doc =>{
            doc.state = Math.min(doc.state,DocumentState.Visited)
            return doc
        })
        .toSet()

        return Array.from(docSet)
    }

    async validate(document:MercuryDocument,cancelToken:CancellationToken){
        let diagnostics = await this.services.validator.validateDocument(document,cancelToken);
        document.diagnostics = diagnostics;
    }
}


function equalURI(a?: URI|string, b?: URI|string): boolean {
    return a?.toString() ===  b?.toString()
}
