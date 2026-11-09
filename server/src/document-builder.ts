import { CancellationToken } from 'vscode-languageserver'
import { DocumentState, MercuryDocument } from './document-manager'
import { interruptAndCheck } from './promise-util'
import { MultiMap } from './multimap'
import { URI } from 'vscode-uri'
import { stream } from './stream'
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
        // 2. index：一轮循环完成每个文档的 AST 遍历 + 全局符号表登记。
        // {infer:false} 关闭 index 内的类型推导，阶段 3 拿到的是
        // 「所有文件 + 全部声明」，与文件访问顺序无关，不再需要按 import 拓扑排序。
        for (const doc of documents) {
            await this.services.index.index(doc, cancelToken, { infer: false });
            await interruptAndCheck(cancelToken)
        }
        // 3. 全局符号表就绪后，才对 clause body 做类型推导 + qualified 名称解析
        this.services.client.setStatus('$(sync~spin)inferring')
        for (const doc of documents) {
            await this.services.typeInferer.inferDocument(doc, cancelToken);
            await interruptAndCheck(cancelToken)
        }
        this.services.client.setStatus('$(sync~spin)linking')
        // 4. linking
        for (const doc of documents) {
            await this.services.linker.link(doc,cancelToken);
            doc.state = DocumentState.Linked
            await interruptAndCheck((cancelToken))
        }
        // 5. validate
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
                this.services.index.delete(deletedDocument);
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
            doc.state = Math.min(doc.state,DocumentState.Indexed)
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
