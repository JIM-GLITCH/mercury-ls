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
	WorkspaceFolder
} from 'vscode-languageserver/node';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';
import * as parser from './parser'
import { MultiMap } from './multimap'
import { Document } from './document'
import { termRange, tokenToRange } from './term'
import * as analyser from './analyser'
import { tokenRange } from './lexer'
import * as linker from './linker' 
import {URI as URI_obj,Utils}from "vscode-uri"
import fs = require("fs")
import path = require('path')
import { nameArity } from './analyser'

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
			referencesProvider:true
			
			
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
	validateWorkspaceTextDocument();

		
});
async function validateWorkspaceTextDocument() {
	let file_count = 0;
	let workspaceFolder = workspaceFolders?workspaceFolders[0]:undefined;
	if(!workspaceFolder) return undefined;

	let rootPath = URI_obj.parse(workspaceFolder.uri).fsPath;
	let filenames = fs.readdirSync(rootPath);
	file_count = filenames.length;
	for (const file_name of filenames) {
		let file_path = path.join(rootPath,file_name);
		let file_uri_string = URI_obj.file(file_path).toString();
		let file_content = fs.readFileSync(file_path).toString();
		let file_textDocument = TextDocument.create(file_uri_string,"mercury",1,file_content)
		await validateTextDocument(file_textDocument);
		// connection.telemetry.logEvent(`${file_name} finished`);
		// connection.window.showInformationMessage(`${file_name} finished`);
		
	}
	connection.sendNotification("fuck")
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
export let docsMap = new Map<URI,Document>();
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
async function validateTextDocument(textDocument: TextDocument): Promise<void> {
	// In this simple example we get the settings for every validate run.
	let document = new Document(textDocument);

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
}

const sleep = (ms: number) => {
	return new Promise(resolve => setTimeout(resolve, ms))
}

connection.onHover(async(params)=>{
	let pos = params.position;
	let uri = params.textDocument.uri;
	let document ;
	while( !(document = docsMap.get(uri))){
		await sleep(100);
	}
	let clause = document.search(pos);
	if(!clause) return undefined;
	let term = clause.search(pos);
	if(!term) return undefined
	
let message =`\`\`\`mercury
${term.name+'/'+term.arity}
\`\`\`
`
	let hover :Hover={
		contents:{
			kind:"markdown",
			value:message
		} as MarkupContent,
		range:termRange(term)
	}
	return hover
})

connection.onDefinition(async (params)=>{
	let pos = params.position;
	let uri = params.textDocument.uri;
	let document ;
	while( !(document = docsMap.get(uri))){
		await sleep(100);
	}
	let clause = document.search(pos);
	if(!clause) return undefined
	let term = clause.search(pos);
	if(!term) return undefined;
	if(term.token.type=="variable"){
		let node = clause.varmap.get(term.name)[0];
		if(!node) return undefined;
		return {
			uri,
			range:termRange(node)
		}
	}

	let defs:Location[]=[];
	let name_arity = nameArity(term);
	let clauses = document.defsMap.get(name_arity);
	for (const clause of clauses) {
		defs.push({
			uri:uri,
			range:termRange(clause.calleeNode)
		})
	}
	for (const moduleName of document.import_modules) {
		let doc = getDoc(moduleName,document);
		if(!doc) continue;
		let clauses = doc.defsMap.get(name_arity);
		for (const clause of clauses) {
			defs.push({
				uri:doc.uri,
				range:termRange(clause.calleeNode)
			})
		}
	}
	return defs;
})

connection.onDocumentSymbol(async (params)=>{
	let uri  = params.textDocument.uri;
	let document ;
	let symbols :DocumentSymbol[]=[];
	while( !(document = docsMap.get(uri))){
		await sleep(100);
	}
	for (const [name_arity ,clauses] of document.defsMap.map) {
		let children:DocumentSymbol[] = []
		for (const clause of clauses) {
			for (const [varname,varTerms] of clause.varmap.map) {
				let varRange  = termRange(varTerms[0]);
				children.push({
					name: varname,
					kind: SymbolKind.Variable,
					range: varRange,
					selectionRange: varRange
				})	
			} 
		}
		let calleeNode = clauses[0].calleeNode;
		symbols.push({
			name: calleeNode.name,
			kind: SymbolKind.Function,
			range: tokenToRange(clauses[0].startToken,clauses[clauses.length-1].endToken),
			selectionRange: termRange(clauses[0].calleeNode),
			children:children,
			detail:"/"+calleeNode.arity
		})		
	}
	return symbols
})

connection.onReferences(async (params)=>{
	let uri  = params.textDocument.uri;
	let pos = params.position
	let document ;
	while( !(document = docsMap.get(uri))){
		await sleep(100);
	}
	let clause = document.search(pos);
	if(!clause ) return undefined;
	let term = clause.search(pos);
	if(!term) return undefined;
	let refs :Location[]=[];
	// 查找 variable的引用 只需要在这个varaible在的clause范围里查找
	if(term.token.type=="variable"){
		for( const refTerm of clause.varmap.get(term.name)){
		  refs.push({uri,range:termRange(refTerm)});
		}
		return refs;
	}

	let name_arity = nameArity(term)

	for (const doc of linker.referencesMap.get(name_arity)) {
		for (const refTerm of doc.refsMap.get(name_arity)) {
			refs.push({uri:doc.uri,range:termRange(refTerm)})
		}
	}
	return refs;

	

})

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

