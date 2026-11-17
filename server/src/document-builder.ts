import { CancellationToken } from 'vscode-languageserver'
import { DocumentState, MercuryDocument } from './document-manager'
import { interruptAndCheck } from './promise-util'
import { MultiMap } from './multimap'
import { URI } from 'vscode-uri'
import { Visitor } from './document-visitor'
import { orderByImports, scanHeader } from './document-order'
import { moduleQualifiedName } from './term'
import type { MercuryServices } from './services'

export type DocumentBuildListener = (built: MercuryDocument[], cancelToken: CancellationToken) => void | Promise<void>
export type DocumentUpdateListener = (changed: URI[], deleted: URI[]) => void

export class DefaultDocumentBuilder{

    constructor(protected readonly services: MercuryServices) {}

    buildPhaseListeners:MultiMap<DocumentState,DocumentBuildListener>= new MultiMap()
    async build(documents:MercuryDocument[],cancelToken:CancellationToken){
        await this.buildDocuments(documents,cancelToken);
    }
    async buildDocuments(documents: MercuryDocument[], cancelToken: CancellationToken, priority?: ReadonlySet<MercuryDocument>) {
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
        // 优先集合（刚打开/编辑的文档）：把它们及其批次内依赖祖先提前 visit。
        // 祖先集对依赖边是「下闭集」——祖先的依赖也在集内——所以提前它们不破坏
        // 拓扑序；无关库文件排到其后，打开的文件不被全库 visit 阻塞
        let visitOrder = ordered
        if (priority?.size) {
            const nameToDoc = new Map<string, MercuryDocument>()
            for (const d of documents) {
                const n = headers.get(d)!.module
                if (n) nameToDoc.set(n, d)
            }
            const reach = new Set<MercuryDocument>()
            const stack = [...priority].filter(d => documents.includes(d))
            while (stack.length) {
                const d = stack.pop()!
                if (reach.has(d)) continue
                reach.add(d)
                for (const imp of headers.get(d)!.imports) {
                    const t = nameToDoc.get(imp)
                    if (t) stack.push(t)
                }
            }
            visitOrder = ordered.filter(d => reach.has(d))
                .concat(ordered.filter(d => !reach.has(d)))
        }
        this.services.client.setStatus('$(sync~spin)analyzing')
        for (const doc of visitOrder) {
            if(doc.state <DocumentState.Visited){
                // 推断按需：priority（刚打开/编辑）或此前已推断过的文档做子句级
                // 类型推断；其余只做索引（inferred 为空，linker/hover 有兜底），
                // 全库 analyzing 耗时随之只剩 parse+index
                const infer = priority?.has(doc) ?? (doc.visitResult?.inferred?.size ?? 0) > 0
                let visitor = new Visitor(this.services);
                await visitor.visit(doc,cancelToken,infer);
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
        // 先解析 changed 文档：parse 是最轻的阶段，先完成让语法级功能立即可用；
        // visit/link/validate 由下面的 buildDocuments 按依赖序渐进处理
        for (const doc of changedDocuments) {
            if (doc.state < DocumentState.Parsed) {
                this.services.documentFactory.update(doc);
                doc.state = DocumentState.Parsed
                await interruptAndCheck(cancelToken)
            }
        }
        let affectedDocuments = this.collectDocuments(changedDocuments,deletedDocuments)
        // changed 文档及其依赖祖先优先 visit（见 buildDocuments 的 priority 处理）
        await this.buildDocuments(affectedDocuments,cancelToken,new Set(changedDocuments))
    }
    collectDocuments(changedDocuments: MercuryDocument[], deletedDocuments:MercuryDocument[]) {
        const all = this.services.documents.all
        // 模块名/imports：visitResult 可能已被 invalidate 清掉，统一从
        // parse 头扫描（scanHeader 不依赖 visit）；已 visit 的文档优先用
        // visitResult（含 include_module 解析结果，与 visit 口径一致）。
        // 结果按文档缓存——BFS 每轮全表扫描时不能重复走 parse 树
        const headers = new Map<MercuryDocument, { module?: string; imports: string[] }>()
        const headerOf = (doc: MercuryDocument) => {
            let h = headers.get(doc)
            if (!h) { h = headerOfRaw(doc); headers.set(doc, h) }
            return h
        }
        const headerOfRaw = (doc: MercuryDocument): { module?: string; imports: string[] } => {
            const m = doc.visitResult?.module
            if (m) return { module: moduleQualifiedName(m), imports: doc.visitResult?.imports ?? [] }
            return doc.parseResult?.value ? scanHeader(doc.parseResult.value) : { imports: [] }
        }
        const affectedModules = new Set<string>()
        for (const doc of [...changedDocuments, ...deletedDocuments]) {
            const m = headerOf(doc).module
            if (m) affectedModules.add(m)
        }
        // 反向依赖传递闭包：imports 命中受影响模块的文档逐层纳入。
        // 注：推断的候选集来自全局导出索引（不限 import），理论上任何模块
        // 的签名变化都可能影响任意已推断文档——下面再把所有 inferred
        // 非空的文档一并纳入重推，保证消歧结果不陈旧
        const docSet = new Set<MercuryDocument>([...changedDocuments, ...deletedDocuments])
        const queue = [...affectedModules]
        while (queue.length) {
            const m = queue.pop()!
            for (const doc of all) {
                if (docSet.has(doc)) continue
                if (headerOf(doc).imports.includes(m)) {
                    docSet.add(doc)
                    const dm = headerOf(doc).module
                    if (dm) queue.push(dm)
                }
            }
        }
        for (const doc of all) {
            if ((doc.visitResult?.inferred?.size ?? 0) > 0) docSet.add(doc)
            if (doc.state < DocumentState.Validated) docSet.add(doc)
        }
        return Array.from(docSet).map(doc => {
            doc.state = Math.min(doc.state, DocumentState.Visited)
            return doc
        })
    }

    async validate(document:MercuryDocument,cancelToken:CancellationToken){
        let diagnostics = await this.services.validator.validateDocument(document,cancelToken);
        document.diagnostics = diagnostics;
    }
}


function equalURI(a?: URI|string, b?: URI|string): boolean {
    return a?.toString() ===  b?.toString()
}
