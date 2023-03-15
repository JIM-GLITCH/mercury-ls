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
    CallHierarchyOutgoingCallsRequest
} from 'vscode-languageserver/node';

import {
    TextDocument
} from 'vscode-languageserver-textdocument';
import {Parser} from './parser'
import { Document } from './document'
import { Term, Clause } from './term'
import {URI,Utils}from "vscode-uri"
import fs = require("fs")
import path = require('path')
import { documentMap } from './globalSpace'
import { DefinitionProvider } from './provide-definition'
import { DeclarationProvider } from './provide-declaration'
import { incomingCallsProvider, outgoingCallsProvider, prepareCallHierarchyProvider } from './provide-callHierarchy'
import { ReferenceProvider } from './provide-reference'
import { HoverProvider } from './provide-hover'
import { DocumentSymbolProvider } from './provide-documentSymbol'
import { mutex } from './promise-util'
import { documentBuilder } from './document-builder'
// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
export const textDocuments: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;    
let workspaceFolders:WorkspaceFolder[]|null;
connection.onInitialize((params: InitializeParams) => {
    
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
});

connection.onInitialized(async() => {
    if (hasConfigurationCapability) {
        // Register for all configuration changes.
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(_event => {
            connection.console.log('Workspace folder change event received.');
        });
    }
});
connection.onNotification("$/validateWorkspaceTextDocuments",async()=>{
    validateWorkspaceTextDocuments()
})
async function validateWorkspaceTextDocuments() {
    let file_count = 0;
    let workspaceFolder = workspaceFolders?workspaceFolders[0]:undefined;
    if(!workspaceFolder) return undefined;

    let rootPath = URI.parse(workspaceFolder.uri).fsPath;
    let filenames = fs.readdirSync(rootPath);
    let file_number = filenames.length;
    for (const file_name of filenames) {
        if(path.extname(file_name) !=".m") continue;
        let file_path = path.join(rootPath,file_name);
        let file_uri_string = URI.file(file_path).toString();
        let file_content = fs.readFileSync(file_path).toString();
        let file_textDocument = TextDocument.create(file_uri_string,"mercury",1,file_content)
        await validateTextDocument(file_textDocument);
        file_count++;
        connection.sendNotification("$/statusBar/text",`Cached files: ${file_count}/${file_number}`);
    }
    connection.sendNotification("$/statusBar/text","Mercury");
    connection.sendNotification("$/statusBar/tooltip",{cached:documentMap.size,usage:process.memoryUsage.rss()/1000000});

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
// Only keep settings for open documents
textDocuments.onDidClose(e => {
    documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
textDocuments.onDidChangeContent(change => {
    let changed = URI.parse(change.document.uri);
    mutex.lock(token=>documentBuilder.update([changed],[],token))
});


connection.onDocumentSymbol(DocumentSymbolProvider);
connection.onHover(HoverProvider);
connection.onDefinition(DefinitionProvider);
connection.onReferences(ReferenceProvider);
connection.onImplementation(DefinitionProvider);
connection.onDeclaration(DeclarationProvider);
connection.onImplementation(DefinitionProvider);
// connection.onTypeDefinition(TypeDefinitionProvider);
connection.onRequest(CallHierarchyPrepareRequest.method,prepareCallHierarchyProvider);
connection.onRequest(CallHierarchyIncomingCallsRequest.method,incomingCallsProvider);
connection.onRequest(CallHierarchyOutgoingCallsRequest.method,outgoingCallsProvider);

connection.onDidChangeWatchedFiles(_change => {
    // Monitored files have change in VSCode
    connection.console.log('We received an file change event');
});

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



// Make the text document manager listen on the connection
// for open, change and close text document events
textDocuments.listen(connection);

// Listen on the connection
connection.listen();

function isNewVersion(textDocument: TextDocument) {
    let old_doc =documentMap.get( textDocument.uri)
    if(!old_doc) 
        return true;
    if(textDocument.version> old_doc.version) 
        return true;
    return false;
}
interface defTerm extends Term{
    clause:Clause
}
interface refTerm extends Term{
    clause:Clause
}

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


