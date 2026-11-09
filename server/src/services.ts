/******************************************************************************
 * 服务容器：所有带状态的 service 都通过 dependency-injection.ts 懒加载注入。
 * 每次调用 createMercuryServices() 都会得到一套完全独立的实例，
 * 因此 server 与每个测试用例互不共享文档/索引状态。
 ******************************************************************************/
import type { Diagnostic } from 'vscode-languageserver'
import { TextDocuments } from 'vscode-languageserver/node'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { inject, Module } from './dependency-injection'
import {
    DefaultMercuryDocumentFactory, DefaultMercuryDocuments,
    MercuryDocumentFactory, MercuryDocuments,
} from './document-manager'
import { GlobalIndex } from './document-index'
import { TypeInferer } from './document-typeinfer'
import { DefaultDocumentValidator, DocumentValidator } from './document-validator'
import { DefaultLinker, Linker } from './document-linker'
import { DefaultDocumentBuilder } from './document-builder'
import { DeafultWoekspaceManager } from './workspace-manager'
import {
    DefinitionProvider, TypeDefinitionProvider,
    findAtTextDocumentPositionTerm, findDefTerms, uriTermToLocation,
} from './provide-definition'
import { DeclarationProvider } from './provide-declaration'
import { ReferenceProvider } from './provide-reference'
import { HoverProvider } from './provide-hover'
import { DocumentSymbolProvider } from './provide-documentSymbol'
import { incomingCallsProvider, outgoingCallsProvider, prepareCallHierarchyProvider } from './provide-callHierarchy'
import { semanticTokensForDocument } from './provide-semantic-tokens'
import { CompletionProvider, CompletionResolve } from './provide-completion'

/**
 * LSP 输出通道。把 `connection`/状态栏从 document-builder 中抽象出来，
 * 避免数据层反向依赖 server.ts（其顶层会创建 LSP 连接并启动定时器）。
 */
export interface LspClient {
    sendNotification(method: string, params?: unknown): void
    sendDiagnostics(params: { uri: string; diagnostics: Diagnostic[] }): void
    setStatus(text: string): void
}

/** 测试环境下的空实现：构建/校验时不需要真实的 LSP 连接。 */
export const noopLspClient: LspClient = {
    sendNotification: () => undefined,
    sendDiagnostics: () => undefined,
    setStatus: () => undefined,
}

/** 把 `(services, ...args) => R` 形式的 provider 绑定成 `(...args) => R`。 */
type Bound<F> = F extends (services: any, ...args: infer A) => infer R ? (...args: A) => R : never

/** 绑定到某个 services 容器上的 LSP 请求处理函数。 */
export type MercuryProviders = {
    definition: Bound<typeof DefinitionProvider>
    typeDefinition: Bound<typeof TypeDefinitionProvider>
    declaration: Bound<typeof DeclarationProvider>
    references: Bound<typeof ReferenceProvider>
    hover: Bound<typeof HoverProvider>
    documentSymbol: Bound<typeof DocumentSymbolProvider>
    prepareCallHierarchy: Bound<typeof prepareCallHierarchyProvider>
    incomingCalls: Bound<typeof incomingCallsProvider>
    outgoingCalls: Bound<typeof outgoingCallsProvider>
    semanticTokens: typeof semanticTokensForDocument
    completion: Bound<typeof CompletionProvider>
    completionResolve: Bound<typeof CompletionResolve>
    findDefTerms: Bound<typeof findDefTerms>
    findAtTextDocumentPositionTerm: Bound<typeof findAtTextDocumentPositionTerm>
    uriTermToLocation: typeof uriTermToLocation
}

export type MercuryServices = {
    /** 编辑器中打开的文本仓库（TextDocuments），每个容器一份 */
    textDocuments: TextDocuments<TextDocument>
    documentFactory: MercuryDocumentFactory
    documents: MercuryDocuments
    /** 阶段 2 的全局符号表：定义 / import / 导出标记（也是模块/导出符号的唯一入口） */
    index: GlobalIndex
    /** 阶段 3 的类型推导 + 名称解析 */
    typeInferer: TypeInferer
    linker: Linker
    validator: DocumentValidator
    builder: DefaultDocumentBuilder
    workspaceManager: DeafultWoekspaceManager
    client: LspClient
    providers: MercuryProviders
}

export type MercuryServicesOptions = {
    client?: LspClient
}

function createMercuryProviders(services: MercuryServices): MercuryProviders {
    return {
        definition: params => DefinitionProvider(services, params),
        typeDefinition: params => TypeDefinitionProvider(services, params),
        declaration: params => DeclarationProvider(services, params),
        references: params => ReferenceProvider(services, params),
        hover: params => HoverProvider(services, params),
        documentSymbol: (params, token) => DocumentSymbolProvider(services, params, token),
        prepareCallHierarchy: (params, token) => prepareCallHierarchyProvider(services, params, token),
        incomingCalls: params => incomingCallsProvider(services, params),
        outgoingCalls: params => outgoingCallsProvider(services, params),
        semanticTokens: semanticTokensForDocument,
        completion: params => CompletionProvider(services, params),
        completionResolve: item => CompletionResolve(services, item),
        findDefTerms: params => findDefTerms(services, params),
        findAtTextDocumentPositionTerm: params => findAtTextDocumentPositionTerm(services, params),
        uriTermToLocation,
    }
}

/** 所有 service 的工厂描述；值可以是工厂函数，也可以是嵌套的子模块。 */
const mercuryServicesModule: Module<MercuryServices> = {
    textDocuments: () => new TextDocuments(TextDocument),
    documentFactory: services => new DefaultMercuryDocumentFactory(services),
    documents: services => new DefaultMercuryDocuments(services),
    index: () => new GlobalIndex(),
    typeInferer: services => new TypeInferer(services.index),
    linker: services => new DefaultLinker(services),
    validator: services => new DefaultDocumentValidator(services),
    builder: services => new DefaultDocumentBuilder(services),
    workspaceManager: () => new DeafultWoekspaceManager(),
    client: () => noopLspClient,
    providers: services => createMercuryProviders(services),
}

/**
 * 创建一套全新的服务容器。server 启动时调用一次，测试中每个用例调用一次。
 * 传入自定义 `client` 可把状态栏/诊断转发给真实的 LSP 连接。
 */
export function createMercuryServices(options: MercuryServicesOptions = {}): MercuryServices {
    const client = options.client ?? noopLspClient
    const module: Module<MercuryServices> = {
        ...mercuryServicesModule,
        client: () => client,
    }
    return inject(module)
}
