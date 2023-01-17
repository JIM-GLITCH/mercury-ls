import { Position, URI } from 'vscode-languageserver'
import { Term, clause } from './term'
import { MultiMap } from './multimap'

export class Document{
	uri:URI
	clauses:clause[];
	defsMap:MultiMap<string,clause>
	refsMap: MultiMap<string, Term>
	typesMap: MultiMap<string, clause>
	declsMap:MultiMap<string, clause>
	include_modules:Set<string>
    import_modules: Set<string>
    exports: Set<string>
	constructor(uri:URI){
		this.uri = uri
		this.clauses = []
		this.defsMap= new MultiMap();
		this.refsMap = new MultiMap(); 
		this.typesMap = new MultiMap()
		this.declsMap = new MultiMap()
		this.include_modules = new Set();
		this.import_modules = new Set();
		this.exports = new Set();
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