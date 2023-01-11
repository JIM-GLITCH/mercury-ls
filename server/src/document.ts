import { Position, URI } from 'vscode-languageserver'
import { clause } from './term'

export class Document{
	uri:URI
	clauses:clause[];
	constructor(uri:URI,clauses:clause[]){
		this.uri = uri
		this.clauses = clauses
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
				return clause.search(pos);
			}
		}
	}
}