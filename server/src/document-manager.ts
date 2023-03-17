import { TextDocument } from 'vscode-languageserver-textdocument'
import { URI } from 'vscode-uri'
import { ParseResult, Parser } from './mercury-parser'
import { Clause, Term } from './term'
import { textDocuments } from './server'
import { readFileSync } from 'fs'
import { Stream, stream } from './stream'
import { VisitResult } from './document-visitor'
import { Diagnostic, Position } from 'vscode-languageserver'

export enum DocumentState {
    /**
     * The text content has changed and needs to be parsed again. The AST held by this outdated
     * document instance is no longer valid.
     */
    Changed = 0,
    /**
     * An AST has been created from the text content. The document structure can be traversed,
     * but cross-references cannot be resolved yet. If necessary, the structure can be manipulated
     * at this stage as a preprocessing step.
     */
    Parsed,
    Visited,
    // /**
    //  * The `IndexManager` service has processed AST nodes of this document. This means the
    //  * exported symbols are available in the global scope and can be resolved from other documents.
    //  */
    // IndexedContent ,
    // /**
    //  * The `ScopeComputation` service has processed this document. This means the local symbols
    //  * are stored in a MultiMap so they can be looked up by the `ScopeProvider` service.
    //  * Once a document has reached this state, you may follow every reference - it will lazily
    //  * resolve its `ref` property and yield either the target AST node or `undefined` in case
    //  * the target is not in scope.
    //  */
    // ComputedScopes ,
    // /**
    //  * The `Linker` service has processed this document. All outgoing references have been
    //  * resolved or marked as erroneous.
    //  */
    Linked ,
    // /**
    //  * The `IndexManager` service has processed AST node references of this document. This is
    //  * necessary to determine which documents are affected by a change in one of the workspace
    //  * documents.
    //  */
    // IndexedReferences ,
    /**
     * The `DocumentValidator` service has processed this document. The language server listens
     * to the results of this phase and sends diagnostics to the client.
     */
    Validated 
}
export interface MercuryDocument{

    importedByDocs: MercuryDocument[]
    
    /** The Uniform Resource Identifier (URI) of the document */
    readonly uri: URI;
    /** The text document used to convert between offsets and positions */
    readonly textDocument: TextDocument;
    /** The current state of the document */
    state: DocumentState;
    /** The parse result holds the Abstract Syntax Tree (AST) and potentially also parser / lexer errors */
    parseResult: ParseResult;
    visitResult?: VisitResult
    linkResult?: {errors:Diagnostic[]}
    /** Result of the scope precomputation phase */
    /** An array of all cross-references found in the AST while linking */
    references: Term[];
    /** Result of the validation phase */
    diagnostics?: Diagnostic[]
}
export interface MercuryDocumentFactory {
    /**
     * Create a Mercury document from a `TextDocument` (usually associated with a file).
     */
    fromTextDocument(textDocument: TextDocument, uri?: URI): MercuryDocument;

    /**
     * Create an Mercury document from an in-memory string.
     */
    fromString(text: string, uri: URI): MercuryDocument;

    /**
     * Create an Mercury document from a model that has been constructed in memory.
     */
    fromModel(model:MercuryDocument , uri: URI): MercuryDocument;
    /**
     * Create a Mercury document for the given URI. The document shall be fetched from the {@link TextDocuments}
     * service if present, and loaded via the configured {@link FileSystemProvider} otherwise.
     */
    create(uri: URI):MercuryDocument

    /**
     * Update the given document after changes in the corresponding textual representation.
     * Method is called by the document builder after it has been requested to build an exisiting
     * document and the document's state is {@link DocumentState.Changed}.
     * The text parsing is expected to be done the same way as in {@link fromTextDocument}
     * and {@link fromString}.
     */
    update(document: MercuryDocument): MercuryDocument
}

export class DefaultMercuryDocumentFactory implements MercuryDocumentFactory{

    fromTextDocument(textDocument: TextDocument, uri?: URI | undefined): MercuryDocument {
        return this.create(uri??URI.parse(textDocument.uri),textDocument)
    }

    fromString(text: string, uri: URI): MercuryDocument {
        return this.create(uri,text)
    }

    fromModel(model: MercuryDocument, uri: URI): MercuryDocument {
        return this.create(uri,{$model:model})
    }
    create(uri:URI,content?:string|TextDocument|{$model:any}){
        // if no document is given, check the textDocuments service first, it maintains documents being opened in an editor
        content ??= textDocuments.get(uri.toString());
        // if still no document is found try to load it from the file system
        content ??= this.getContentFromFileSystem(uri);
        
        if(typeof content === "string"){
            let parseResult = this.parse(uri,content)
            return this.createMercuryDocument(parseResult,uri,undefined,content)
        }else if('$model' in content){
            let parseResult = {value:content.$model,errors:[]}
            return this.createMercuryDocument(parseResult,uri);
        }else{
            let parseResult = this.parse(uri,content.getText());
            return this.createMercuryDocument(parseResult,uri,content)
        }
    }
    
    protected createMercuryDocument(parseResult:any,uri:URI,textDocument?:TextDocument,text?:string){
        let document :MercuryDocument;
        if(textDocument){
            document = {
                parseResult,
                uri,
                state:DocumentState.Parsed,
                references:[],
                textDocument,
                importedByDocs:[]
            }
        } else{
            let textDocumentGetter = this.createTextDocumentGetter(uri,text);
            document = {
                parseResult,
                uri,
                state:DocumentState.Parsed,
                references:[],
                get textDocument(){
                    return textDocumentGetter();
                },
                importedByDocs:[]
            }
        }
        parseResult.value.$document = document;
        return document;
    }
    update(document: MercuryDocument): MercuryDocument {
        let textDocument = textDocuments.get(document.uri.toString())
        let text = textDocument?textDocument.getText(): this.getContentFromFileSystem(document.uri)
        
        if(textDocument){
            Object.defineProperty(
                document,'textDocument',{
                    value:textDocument
                }
            )
        } else{
            let textDocumentGetter = this.createTextDocumentGetter(document.uri,text);
            Object.defineProperty(
                document,'textDocument',{
                    get :textDocumentGetter
                }
            )
        }

        document.parseResult = this.parse(document.uri,text);
        document.parseResult.value.document = document;
        return document
    }
    protected createTextDocumentGetter(uri:URI,text?:string){
        let textDoc:TextDocument|undefined = undefined;
        return ()=>{
            return textDoc ??= TextDocument.create(
                uri.toString(),
                "mercury",
                0,
                text??""
                )
        }
    }
    protected getContentFromFileSystem(uri: URI){
        return readFileSync(uri.fsPath,"utf-8")
    }
    protected parse(uri:URI,text:string):ParseResult{
        return Parser.parse(text)
    }

}
export let mercuryDocumentFactory = new DefaultMercuryDocumentFactory()
/**
 * Shared service for managing Mercury documents.
 */
export interface MercuryDocuments {

    /**
     * A stream of all documents managed under this service.
     */
    readonly all: Stream<MercuryDocument>

    /**
     * Manage a new document under this service.
     * @throws an error if a document with the same URI is already present.
     */
    addDocument(document: MercuryDocument): void;

    /**
     * Retrieve the document with the given URI, if present. Otherwise create a new document
     * and add it to the managed documents.
     */
    getOrCreateDocument(uri: URI): MercuryDocument;

    /**
     * Returns `true` if a document with the given URI is managed under this service.
     */
    hasDocument(uri: URI): boolean;

    /**
     * Flag the document with the given URI as `Changed`, if present, meaning that its content
     * is no longer valid. The content (parseResult) stays untouched, while internal data may
     * be dropped to reduce memory footprint.
     *
     * @returns the affected {@link MercuryDocument} if existing for convenience
     */
    invalidateDocument(uri: URI): MercuryDocument | undefined;

    /**
     * Remove the document with the given URI, if present, and mark it as `Changed`, meaning
     * that its content is no longer valid. The next call to `getOrCreateDocument` with the same
     * URI will create a new document instance.
     *
     * @returns the affected {@link MercuryDocument} if existing for convenience
     */
    deleteDocument(uri: URI): MercuryDocument | undefined;
}

export class DefaultMercuryDocuments implements MercuryDocuments{
    protected readonly documentMap:Map<string,MercuryDocument>= new Map()
    get size(){
        return this.documentMap.size
    }
    get all(): Stream<MercuryDocument>{
        return stream(this.documentMap.values())
    }
    addDocument(document: MercuryDocument): void {
        const uriString = document.uri.toString();
        if (this.documentMap.has(uriString)) {
            throw new Error(`A document with the URI '${uriString}' is already present.`);
        }
        this.documentMap.set(uriString, document);
    }
    getOrCreateDocument(uri: URI): MercuryDocument {
        const uriString = uri.toString();
        let MercuryDoc = this.documentMap.get(uriString);
        if (MercuryDoc) {
            // The document is already present in our map
            return MercuryDoc;
        }
        MercuryDoc = mercuryDocumentFactory.create(uri);
        this.documentMap.set(uriString, MercuryDoc);
        return MercuryDoc;
    }
    hasDocument(uri: URI): boolean {
        return this.documentMap.has(uri.toString());
    }
    invalidateDocument(uri: URI): MercuryDocument | undefined {
        let uriString = uri.toString()
        let MercuryDoc = this.documentMap.get(uriString);
        if(MercuryDoc){
            MercuryDoc.state = DocumentState.Changed
            MercuryDoc.references = []
            MercuryDoc.diagnostics = []
        }
        return MercuryDoc;
    }
    deleteDocument(uri: URI): MercuryDocument | undefined {
        const uriString = uri.toString();
        const MercuryDoc = this.documentMap.get(uriString);
        if (MercuryDoc) {
            MercuryDoc.state = DocumentState.Changed;
            this.documentMap.delete(uriString);
        }
        return MercuryDoc;
    }
    
}
export let mercuryDocuments = new DefaultMercuryDocuments();