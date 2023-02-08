import type{ Diagnostic, Range } from 'vscode-languageserver'
import type{ ParserState } from './parser'
import type{ Token } from './lexer'
import type{ Document } from './document'
import type{ Term } from './term'
import { docsMap, moduleUriMap } from './globalSpace'

export function error(message:string,token:Token,ps:{errors:Diagnostic[]}) {
	let range = tokenRange(token);
    ps.errors.push({
        range,
        message
    })
}

export function tokenRange( token:Token):Range{
	return {
		start:{
			line:token.line-1,
			character:token.col-1
		},
		end:{
			line:token.line+token.lineBreaks-1,
			character:token.lineBreaks
				?	(token.text.length-token.text.lastIndexOf("\n")-1)
				:	(token.col+token.text.length-1)
		}
	}
}
export function nameArity(term:Term){
    return term.name+'/'+term.arity;
}
export function showNameArity(term:Term){
    return term.name+' /'+term.arity;
}

export function sleep(ms: number){
    return new Promise(resolve => setTimeout(resolve, ms))
}

export function getDocumentFromModule(module: string): Document|undefined {
    let uri = moduleUriMap.get(module);
    if(!uri)
        return undefined;
    return docsMap.get(uri);
}
