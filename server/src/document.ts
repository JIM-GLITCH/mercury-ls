import { Diagnostic, Position, URI } from 'vscode-languageserver'
import { Term, clause } from './term'
import { MultiMap } from './multimap'
import { URI as URI_obj,Utils } from 'vscode-uri'
import { TextDocument } from 'vscode-languageserver-textdocument'
export interface RefTerm extends Term{
	clause:clause
}export interface DefTerm extends Term{
	clause:clause
}
export class Document{
    refMap: MultiMap<string,RefTerm>
    moduleDefMap: MultiMap<string,Term>
	getText (): string  {
		return this.textDocument.getText();
    }
	version: number
	uri:URI
	uri_obj:URI_obj
	clauses:clause[];
	funcDefMap:MultiMap<string,DefTerm>
	funcRefMap: MultiMap<string, RefTerm>
	funcDeclMap:MultiMap<string, Term>
	predDefMap:MultiMap<string,DefTerm>
	predRefMap: MultiMap<string, RefTerm>
	predDeclMap:MultiMap<string, Term>
	typeDefMap: MultiMap<string, DefTerm>
	typeRefMap: MultiMap<string, Term>
	typeDeclMap: MultiMap<string, Term>
	includeModules:Set<string>
    importModules: Set<string>
    exportFuncs: Set<string>
    exportPreds: Set<string>
    exportTypes: Set<string>
	fileNameWithoutExt: string
	textDocument:TextDocument
	errors: Diagnostic[]
	constructor(textDocument:TextDocument){
		this.textDocument = textDocument;
		this.uri = textDocument.uri
		this.clauses = []
		this.funcDefMap= new MultiMap();
		this.funcRefMap= new MultiMap();
		this.funcDeclMap= new MultiMap();
		this.typeDefMap= new MultiMap();
		this.typeRefMap= new MultiMap();
		this.typeDeclMap= new MultiMap();
		this.predDefMap= new MultiMap();
		this.predRefMap = new MultiMap()
		this.predDeclMap = new MultiMap()
		this.includeModules = new Set();
		this.importModules = new Set();
		this.exportFuncs =new Set();
		this.exportPreds =new Set();
		this.exportTypes =new Set();
		this.uri_obj = URI_obj.parse(this.uri)
		                                             // slice(0,-2) 去掉  文件名中的 ".m"
		this.fileNameWithoutExt = Utils.basename(this.uri_obj).slice(0,-2);
		this.errors = [];
		this.version = textDocument.version;
		this.refMap = new MultiMap()
		this.moduleDefMap=new MultiMap();
	}
	search(pos:Position){ 
		let clauses = this.clauses;
		let low = 0, high =clauses.length-1;
		const line = pos.line;
		while (low <= high){
			const mid = Math.floor((low + high)/2)
			const clause = clauses[mid];
			let clauseRange = clause.range();
			if (clauseRange.start.line>line){
				high = mid-1;
			}
			else if(clauseRange.end.line<line){
				low = mid + 1;
			}
			else{
					return clause.search(pos);

			}
		}

	}
}