import { Diagnostic, Position, URI } from 'vscode-languageserver'
import { Term, clause } from './term'
import { MultiMap } from './multimap'
import { URI as URI_obj,Utils } from 'vscode-uri'
import { TextDocument } from 'vscode-languageserver-textdocument'

export class Document{
    getText (): string  {
		return this.textDocument.getText();
    }
	uri:URI
	uri_obj:URI_obj
	clauses:clause[];
	defsMap:MultiMap<string,clause>
	refsMap: MultiMap<string, Term>
	typesMap: MultiMap<string, clause>
	declsMap:MultiMap<string, clause>
	include_modules:Set<string>
    import_modules: Set<string>
    exports: Set<string>
	module_name: string
	textDocument:TextDocument
	errors: Diagnostic[]
	constructor(textDocument:TextDocument){
		this.textDocument = textDocument;
		this.uri = textDocument.uri
		this.clauses = []
		this.defsMap= new MultiMap();
		this.refsMap = new MultiMap(); 
		this.typesMap = new MultiMap()
		this.declsMap = new MultiMap()
		this.include_modules = new Set();
		this.import_modules = new Set();
		this.exports = new Set();
		this.uri_obj = URI_obj.parse(this.uri)
		                                             // slice(0,-2) 去掉  文件名中的 ".m"
		this.module_name = Utils.basename(this.uri_obj).slice(0,-2);
		this.errors = [];
		
	}
	search(pos:Position){ 
		let clauses = this.clauses;
		let low = 0, high =clauses.length;
		const line = pos.line;
		while (low < high){
			const mid = Math.floor((low + high)/2)
			const clause = clauses[mid];
			let clauseRange = clause.range();
			if (clauseRange.start.line>line){
				high = mid;
			}
			else if(clauseRange.end.line<line){
				low = mid + 1;
			}
			else{
				return clause
			}
		}
	}
}