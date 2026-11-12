/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
    createConnection,
    ProposedFeatures,
    InitializeParams,
    DidChangeConfigurationNotification,
    TextDocumentSyncKind,
    InitializeResult,
    Position,
    WorkspaceFolder,                                     
    CallHierarchyPrepareRequest,
    CallHierarchyIncomingCallsRequest,
    CallHierarchyOutgoingCallsRequest,
    FileChangeType,
    InitializedParams,
    CancellationToken,
    CancellationTokenSource,
    HandlerResult,
    TextDocumentIdentifier,
    RequestHandler,
    ResponseError,
    LSPErrorCodes,
    WorkDoneProgress,
    WorkDoneProgressCreateRequest,
    WorkDoneProgressCancelNotification,
    SemanticTokensRequest,
} from 'vscode-languageserver/node';

import {Parser} from './mercury-parser'
import { Document } from './document'
import { Term, Clause } from './term'
import {URI,Utils}from "vscode-uri"
import fs = require("fs")
import path = require('path')
import { semanticTokenLegend } from './provide-semantic-tokens'
import { MutexLock, isOperationCancelled } from './promise-util'
import { stream } from './stream'
import { createMercuryServices, type LspClient } from './services'
// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
export const connection = createConnection(ProposedFeatures.all);
export const mutex = new MutexLock;

/** 把 LSP 连接包装成数据层可注入的输出通道（状态栏 + 诊断）。 */
const client: LspClient = {
    sendNotification: (method, params) => connection.sendNotification(method, params),
    sendDiagnostics: params => connection.sendDiagnostics(params),
    setStatus: text => connection.sendNotification('$/statusBar/text', text),
}

/** 当前 server 进程唯一的一套服务容器。 */
export const services = createMercuryServices({ client });

// Create a simple text document manager (定义已迁至 document-manager.ts)

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;    
let workspaceFolders:WorkspaceFolder[]|null|undefined;
function onInitialize(params: InitializeParams) {
    
    workspaceFolders = params.workspaceFolders;

    const capabilities = params.capabilities;
    // Does the client support the `workspace/configuration` request?
    // If not, we fall back using global settings.
    hasConfigurationCapability = !!(
        capabilities.workspace && !!capabilities.workspace.configuration
    );
    hasWorkspaceFolderCapability = !!(
        capabilities.workspace && !!capabilities.workspace.workspaceFolders
    );
    hasDiagnosticRelatedInformationCapability = !!(
        capabilities.textDocument &&
        capabilities.textDocument.publishDiagnostics &&
        capabilities.textDocument.publishDiagnostics.relatedInformation
    );

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            // 敲下 `.` 时按 `.` 前方的模块名补全其导出符号
            completionProvider: {
                resolveProvider: true,
                triggerCharacters: ['.']
            },
            hoverProvider:true,
            definitionProvider:true,
            typeDefinitionProvider:true,
            documentSymbolProvider:true,
            referencesProvider:true,
            callHierarchyProvider:true,
            declarationProvider:true,
            implementationProvider:true,
            semanticTokensProvider: {
                legend: semanticTokenLegend,
                range: false,
                full: { delta: false }
            }
        }
    };
    if (hasWorkspaceFolderCapability) {
        result.capabilities.workspace = {
            workspaceFolders: {
                supported: true
            }
        };
    }
    return result;
};

function onInitialized(params:InitializedParams){
    if (hasConfigurationCapability) {
        // Register for all configuration changes.
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(_event => {
            connection.console.log('Workspace folder change event received.');
        });
    }
    
};
connection.onNotification("$/initialWorkspace",async()=>{
    initializeWorkspace()
})
export namespace sendBarText{
    
    export function initializing(){
        return client.setStatus("$(sync~spin)initializing");
    }
    export function Mercury(){
        return client.setStatus("Mercury");
    }
    export function parsing(){
        return client.setStatus("$(sync~spin)parsing");
    }
    export function linking(){
        return client.setStatus("$(sync~spin)linking");
    }
    export function validating(){
        return client.setStatus("$(sync~spin)validating");
    }

}
export function sendMemoryUsage(){
    return connection.sendNotification("$/statusBar/tooltip",{cached:services.documents.size,usage:process.memoryUsage.rss()/1000000});
}
async function initializeWorkspace() {
    sendBarText.initializing()
    let file_count = 0;
    let folders = workspaceFolders??[]
    // await Promise.all(
    //     folders.map(wf =>[wf,URI.parse(wf.uri)])
    //     .map(async entry=>traverseFolder(...entry ,fileExtenstions ,coll))
    // )
    let rootPath = URI.parse(folders[0].uri).fsPath;

    // Recursively find all .m files in the workspace
    function findMercuryFiles(dir: string, results: string[] = []): string[] {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                findMercuryFiles(fullPath, results);
            } else if (path.extname(file) === '.m') {
                results.push(fullPath);
            }
        }
        return results;
    }

    const mercurFiles = findMercuryFiles(rootPath);

    sendBarText.parsing()
    let docs = stream(mercurFiles)
    .map(filepath=>services.documents.getOrCreateDocument( URI.file(filepath)))
    .toArray()

    await services.builder.build(docs,CancellationToken.None);
    sendBarText.Mercury()
}
// The example settings     
interface ExampleSettings {
    maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ExampleSettings = { maxNumberOfProblems: 1000 };
let globalSettings: ExampleSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<ExampleSettings>> = new Map();

// 

connection.onDidChangeConfiguration(change => {
    if (hasConfigurationCapability) {
        // Reset all cached document settings
        documentSettings.clear();
    } else {
        globalSettings = <ExampleSettings>(
            (change.settings.languageServerExample || defaultSettings)
        );
    }

    // Revalidate all open text documents
    // textDocuments.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
    if (!hasConfigurationCapability) {
        return Promise.resolve(globalSettings);
    }
    let result = documentSettings.get(resource);
    if (!result) {
        result = connection.workspace.getConfiguration({
            scopeUri: resource,
            section: 'languageServerExample'
        });
        documentSettings.set(resource, result);
    }
    return result;
}



// `module.` 补全：`provide-completion.ts` 里读原始文本取 `.` 前方的 token，
// 按模块限定名查全局导出索引。走 cancelableRequest 与其它 provider 一致。
connection.onCompletion(cancelableRequest(services.providers.completion));
connection.onCompletionResolve(services.providers.completionResolve);




// function isNewVersion(textDocument: TextDocument) {
//     let old_doc =documentMap.get( textDocument.uri)
//     if(!old_doc) 
//         return true;
//     if(textDocument.version> old_doc.version) 
//         return true;
//     return false;
// }

// async function validateTextDocument(textDocument: TextDocument): Promise<void> {
//     // In this simple example we get the settings for every validate run.
//     let document = new Document(textDocument);

//     if(!isNewVersion(textDocument)){
//         return;
//     }
//     // 1. parse string to ast
//     Parser.parse_document(document);
//     // 2. analyse ast node's semantic info
//     analyser.analyse(document);
//     // // 3. link the definition and references in global scope
//     // linker.link(document);
//     // 4. store this document
//     documentMap.set(document.uri , document)
//     // Send the computed diagnostics to VSCode.
//     connection.sendDiagnostics({ uri: document.uri, diagnostics:document.errors });
//     connection.sendNotification("$/statusBar/tooltip",{cached:documentMap.size,usage:process.memoryUsage.rss()/1000000});
// }

function addDocumentHander(){
    function onDidChange(changed:URI[],deleted:URI[]){
        mutex.lock(token=>services.builder.update(changed,deleted,token));
    }
    services.textDocuments.onDidChangeContent(change => {
        onDidChange([URI.parse(change.document.uri)],[])
    });
    services.textDocuments.onDidOpen(change => {
        onDidChange([URI.parse(change.document.uri)],[])
    });
    connection.onDidChangeWatchedFiles(params => {
        const changedUris: URI[] = [];
        const deletedUris: URI[] = [];
        for (const change of params.changes) {
            const uri = URI.parse(change.uri);
            if (change.type === FileChangeType.Deleted) {
                deletedUris.push(uri);
            } else {
                changedUris.push(uri);
            }
        }
        onDidChange(changedUris, deletedUris);
    });
}

function  cancelableRequest<P extends { textDocument: TextDocumentIdentifier }, R, E = void>(
    serviceCall: ( params: P, cancelToken: CancellationToken) => HandlerResult<R, E>
): RequestHandler<P, R | null, E> {
    return async (params: P, cancelToken: CancellationToken)=>{
        try {
            return await serviceCall(params, cancelToken);
        } catch (err) {
            return responseError<E>(err);
    }
    }
}
function responseError<E = void>(err: unknown): ResponseError<E> {
    if (isOperationCancelled(err)) {
        return new ResponseError(LSPErrorCodes.RequestCancelled, 'The request has been cancelled.');
    }
    if (err instanceof ResponseError) {
        return err;
    }
    throw err;
}

connection.onInitialize(params=>onInitialize(params))
connection.onInitialized(params=>onInitialized(params))
addDocumentHander()
    // Only keep settings for open documents
services.textDocuments.onDidClose(e => {documentSettings.delete(e.document.uri);});
connection.onDocumentSymbol(cancelableRequest(services.providers.documentSymbol));
connection.onHover(cancelableRequest(services.providers.hover));
connection.onDefinition(cancelableRequest(services.providers.definition));
connection.onTypeDefinition(cancelableRequest(services.providers.typeDefinition));
connection.onReferences(cancelableRequest(services.providers.references));
connection.onImplementation(cancelableRequest(services.providers.definition));
connection.onDeclaration(cancelableRequest(services.providers.declaration));
connection.onImplementation(cancelableRequest(services.providers.definition));
connection.onRequest(SemanticTokensRequest.type, params => {
    const uri = URI.parse(params.textDocument.uri);
    const document = services.documents.getOrCreateDocument(uri);
    return services.providers.semanticTokens(document);
});
// connection.onTypeDefinition(TypeDefinitionProvider);
connection.onRequest(CallHierarchyPrepareRequest.method,cancelableRequest(services.providers.prepareCallHierarchy));
connection.onRequest(CallHierarchyIncomingCallsRequest.method,services.providers.incomingCalls);
connection.onRequest(CallHierarchyOutgoingCallsRequest.method,services.providers.outgoingCalls);


services.textDocuments.listen(connection)
connection.listen()
setInterval(()=>sendMemoryUsage(),1000)
