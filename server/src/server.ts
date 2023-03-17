/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    InitializeParams,
    DidChangeConfigurationNotification,
    CompletionItem,
    CompletionItemKind,
    TextDocumentPositionParams,
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
    LSPErrorCodes
} from 'vscode-languageserver/node';

import {
    TextDocument
} from 'vscode-languageserver-textdocument';
import {Parser} from './mercury-parser'
import { Document } from './document'
import { Term, Clause } from './term'
import {URI,Utils}from "vscode-uri"
import fs = require("fs")
import path = require('path')
import { DefinitionProvider } from './provide-definition'
import { DeclarationProvider } from './provide-declaration'
import { incomingCallsProvider, outgoingCallsProvider, prepareCallHierarchyProvider } from './provide-callHierarchy'
import { ReferenceProvider } from './provide-reference'
import { HoverProvider } from './provide-hover'
import { DocumentSymbolProvider } from './provide-documentSymbol'
import { MutexLock, isOperationCancelled } from './promise-util'
import { documentBuilder } from './document-builder'
import { DocumentState, mercuryDocuments } from './document-manager'
import { stream } from './stream'
// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
export const connection = createConnection(ProposedFeatures.all);
export const mutex = new MutexLock;

// Create a simple text document manager.
export const textDocuments: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

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
            // Tell the client that this server supports code completion.
            completionProvider: {
                resolveProvider: true
            },
            hoverProvider:true,
            definitionProvider:true,
            documentSymbolProvider:true,
            referencesProvider:true,
            callHierarchyProvider:true,
            declarationProvider:true,
            implementationProvider:true
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
connection.onNotification("$/validateWorkspaceTextDocuments",async()=>{
    initializeWorkspace()
})
async function initializeWorkspace() {
    connection.sendNotification("$/statusBar/text","initializing");
    let file_count = 0;
    let folders = workspaceFolders??[]
    // await Promise.all(
    //     folders.map(wf =>[wf,URI.parse(wf.uri)])
    //     .map(async entry=>traverseFolder(...entry ,fileExtenstions ,coll))
    // )
    let rootPath = URI.parse(folders[0].uri).fsPath;
    let filenames = fs.readdirSync(rootPath);
    let file_number = filenames.length;
    let docs = stream(filenames).filter(filename=>path.extname(filename) ==".m")
    .map(filename=>mercuryDocuments.getOrCreateDocument( URI.file(path.join(rootPath,filename))))
    .toArray()
    let mutex = new MutexLock;
    mutex.lock(token =>documentBuilder.build(docs,token))

    connection.sendNotification("$/statusBar/text","Mercury");
    connection.sendNotification("$/statusBar/tooltip",{cached:mercuryDocuments.size,usage:process.memoryUsage.rss()/1000000});

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



// This handler provides the initial list of the completion items.
connection.onCompletion(
    (_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
        // The pass parameter contains the position of the text document in
        // which code complete got requested. For the example we ignore this
        // info and always provide the same completion items.
        return [
            {
                label: 'TypeScript',
                kind: CompletionItemKind.Text,
                data: 1
            },
            {
                label: 'JavaScript',
                kind: CompletionItemKind.Text,
                data: 2
            }
        ];
    }
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
    (item: CompletionItem): CompletionItem => {
        if (item.data === 1) {
            item.detail = 'TypeScript details';
            item.documentation = 'TypeScript documentation';
        } else if (item.data === 2) {
            item.detail = 'JavaScript details';
            item.documentation = 'JavaScript documentation';
        }
        return item;
    }
);




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
        mutex.lock(token=>documentBuilder.update(changed,deleted,token));
    }
    textDocuments.onDidChangeContent(change => {
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
    connection.onDidChangeWatchedFiles(params => {
        const changedUris = params.changes.filter(e => e.type !== FileChangeType.Deleted).map(e => URI.parse(e.uri));
        const deletedUris = params.changes.filter(e => e.type === FileChangeType.Deleted).map(e => URI.parse(e.uri));
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
textDocuments.onDidClose(e => {documentSettings.delete(e.document.uri);});
connection.onDocumentSymbol(cancelableRequest(DocumentSymbolProvider));
connection.onHover(cancelableRequest(HoverProvider));
connection.onDefinition(cancelableRequest(DefinitionProvider));
connection.onReferences(cancelableRequest(ReferenceProvider));
connection.onImplementation(cancelableRequest(DefinitionProvider));
connection.onDeclaration(cancelableRequest(DeclarationProvider));
connection.onImplementation(cancelableRequest(DefinitionProvider));
// connection.onTypeDefinition(TypeDefinitionProvider);
connection.onRequest(CallHierarchyPrepareRequest.method,cancelableRequest(prepareCallHierarchyProvider));
connection.onRequest(CallHierarchyIncomingCallsRequest.method,incomingCallsProvider);
connection.onRequest(CallHierarchyOutgoingCallsRequest.method,outgoingCallsProvider);


textDocuments.listen(connection)
connection.listen()
