/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
    createConnection,
    TextDocuments,
    Diagnostic,
    DiagnosticSeverity,
    ProposedFeatures,
    InitializeParams,
    DidChangeConfigurationNotification,
    CompletionItem,
    CompletionItemKind,
    TextDocumentPositionParams,
    TextDocumentSyncKind,
    InitializeResult,
    Range,
    Position,
    URI,
    Hover,
    MarkupContent,
    Definition,
    Location,
    DocumentSymbol,
    SymbolKind,
    WorkspaceFolder,
    DocumentSymbolParams,
    DefinitionParams,
    ReferenceParams,
    HoverParams,
    CallHierarchyPrepareParams,
    CallHierarchyItem,
    CallHierarchyIncomingCallsParams,
    CallHierarchyIncomingCall,
    DeclarationParams,
    CallHierarchyOutgoingCall,
    CallHierarchyPrepareRequest,
    CallHierarchyIncomingCallsRequest,
    CallHierarchyOutgoingCallsRequest
} from 'vscode-languageserver/node';

import {
    TextDocument
} from 'vscode-languageserver-textdocument';
import * as parser from './parser'
import { MultiMap } from './multimap'
import { Document } from './document'
import { Term, clause, termRange, tokenToRange } from './term'
import * as analyser from './analyser'
import * as linker from './linker' 
import {URI as URI_obj,Utils}from "vscode-uri"
import fs = require("fs")
import path = require('path')
import { P } from 'ts-pattern'
import { nameArity, sleep, tokenRange } from './utils'
import * as globalSpace from"./globalSpace"
import { docsMap } from './globalSpace'
import { DefinitionProvider } from './definition-provider'
import { DeclarationProvider } from './declaration-provider'
import { outgoingCallsProvider, prepareCallHierarchyProvider } from './callHierarchy-provider'
// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

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

    let rootPath = URI_obj.parse(workspaceFolder.uri).fsPath;
    let filenames = fs.readdirSync(rootPath);
    let file_number = filenames.length;
    for (const file_name of filenames) {
        let file_path = path.join(rootPath,file_name);
        let file_uri_string = URI_obj.file(file_path).toString();
        let file_content = fs.readFileSync(file_path).toString();
        let file_textDocument = TextDocument.create(file_uri_string,"mercury",1,file_content)
        await validateTextDocument(file_textDocument);
        file_count++;
        connection.sendNotification("$/statusBar/text",`Cached files: ${file_count}/${file_number}`);
    }
    connection.sendNotification("$/statusBar/text","Mercury");
    connection.sendNotification("$/statusBar/tooltip",{cached:docsMap.size,usage:process.memoryUsage.rss()/1000000});

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
    documents.all().forEach(validateTextDocument);
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
documents.onDidClose(e => {
    documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
    validateTextDocument(change.document);
});




connection.onDocumentSymbol(DocumentSymbolProvider);
connection.onHover(HoverProvider);
connection.onDefinition(DefinitionProvider);
// connection.onReferences(ReferenceProvider);
connection.onImplementation(DefinitionProvider);
connection.onDeclaration(DeclarationProvider);
connection.onImplementation(DefinitionProvider);
// connection.onTypeDefinition(TypeDefinitionProvider);
connection.onRequest(CallHierarchyPrepareRequest.method,prepareCallHierarchyProvider);
connection.onRequest(CallHierarchyIncomingCallsRequest.method,outgoingCallsProvider);
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
documents.listen(connection);

// Listen on the connection
connection.listen();
function getDoc(moduleName: string, document: Document) {
    let uri = document.uri;
    let uri_obj = URI_obj.parse(uri);
    let moduleURI_string = Utils.joinPath(
        Utils.dirname(uri_obj),
        moduleName+".m"
    ).toString()
    return docsMap.get(moduleURI_string);
}

function isNewVersion(textDocument: TextDocument) {
    let old_doc =docsMap.get( textDocument.uri)
    if(!old_doc) 
        return true;
    if(textDocument.version> old_doc.version) 
        return true;
    return false;
}
interface defTerm extends Term{
    clause:clause
}
interface refTerm extends Term{
    clause:clause
}
async function DocumentSymbolProvider(params: DocumentSymbolParams) {
    let uri  = params.textDocument.uri;
    let document ;
    while( !(document = docsMap.get(uri))){
        await sleep(100);
    }
    let symbols :DocumentSymbol[]=[];
    for (const [name_arity ,funcTerms] of document.funcDefMap.map) {
        let children:DocumentSymbol[] = []
        for (const funcTerm of funcTerms as defTerm[]) {
            for (const [varName,varTerms] of funcTerm.clause.varmap.map) {
                let varRange  = termRange(varTerms[0]);
                children.push({
                    name: varName,
                    kind: SymbolKind.Variable,
                    range: varRange,
                    selectionRange: varRange
                })	
            } 
        }
        let funcTerm = funcTerms[0];
        symbols.push({
            name: name_arity,
            kind:SymbolKind.Operator,
            range: tokenToRange(funcTerms[0].clause!.startToken,funcTerms[funcTerms.length-1].clause!.endToken),
            selectionRange: termRange(funcTerm),
            children:children,
        })
    }

    for (const [name ,predTerms] of document.predDefMap.map) {
        let children:DocumentSymbol[] = []
        for (const funcTerm of predTerms as defTerm[]) {
            for (const [varName,varTerms] of funcTerm.clause.varmap.map) {
                let varRange  = termRange(varTerms[0]);
                children.push({
                    name: varName,
                    kind: SymbolKind.Variable,
                    range: varRange,
                    selectionRange: varRange
                })	
            } 
        }
        let funcTerm = predTerms[0];
        symbols.push({
            name: name,
            kind:SymbolKind.Function,
            range: tokenToRange(predTerms[0].clause!.startToken,predTerms[predTerms.length-1].clause!.endToken),
            selectionRange: termRange(funcTerm),
            children:children,
        })
    }
    return symbols
} 

// async function ReferenceProvider(params:ReferenceParams) {
//     let uri  = params.textDocument.uri;
//     let pos = params.position
//     let document ;
//     while( !(document = docsMap.get(uri))){
//         await sleep(100);
//     }
//     let{term, clause} = document.search(pos);

//     if(!term) return undefined;
//     let refs :Location[]=[];
//     // 查找 variable的引用 只需要在这个varaible在的clause范围里查找
//     if(term.token.type=="variable"){
//         for( const refTerm of clause!.varmap.get(term.name)){
//           refs.push({uri,range:termRange(refTerm)});
//         }
//         return refs;
//     }

//     let name_arity = nameArity(term)
//     // 找到这个term的定义的位置
//     for (const doc of globalSpace.referencesMap.get(name_arity)) {
//         for (const refTerm of doc.refsMap.get(name_arity)) {
//             refs.push({uri:doc.uri,range:termRange(refTerm)})
//         }
//     }
//     return refs;
// }
async function HoverProvider(params:HoverParams) {
    let pos = params.position;
    let uri = params.textDocument.uri;
    let term = docsMap.get(uri)?.search(pos);
    if(!term) return;
    let msg;
    forloop:
    for(;;){
        switch (term.semanticType){
            case 'func':
                msg = `func ${nameArity(term)}`
                break forloop;
            case 'pred':
                msg = `pred ${nameArity(term)}`
                break forloop;
            case 'type':
                msg = `type ${nameArity(term)}`
                break forloop;
            case 'module':
                msg = `module ${term.name}`
                break forloop;
            case undefined:
                // 如果term没有 semanticType 那么根据syntaxType处理
                break;
        }
        
        switch (term.syntaxType) {
            case 'string':
            case 'variable':
            case 'integer':
            case 'float':
            case 'implementation_defined':
                msg = term.name;
                break forloop;
            case 'atom':
                msg = nameArity(term);
                break forloop;
        }
    }    
let message =`\`\`\`mercury
${msg}
\`\`\`
`
    return {
        contents:{
            kind:"markdown",
            value:message
        } as MarkupContent,
        range:termRange(term)
    } as Hover
}

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
    // In this simple example we get the settings for every validate run.
    let document = new Document(textDocument);

    if(!isNewVersion(textDocument)){
        return;
    }
    // 1. parse string to ast
    parser.parse(document);
    // 2. analyse ast node's semantic info
    analyser.analyse(document);
    // 3. link the definition and references in global scope
    linker.link(document);
    // 4. store this document
    docsMap.set(document.uri , document)
    // Send the computed diagnostics to VSCode.
    connection.sendDiagnostics({ uri: document.uri, diagnostics:document.errors });
    connection.sendNotification("$/statusBar/tooltip",{cached:docsMap.size,usage:process.memoryUsage.rss()/1000000});
}

function getTerm(uri: string, pos: Position) {
    return docsMap.get(uri)?.search(pos);
}

