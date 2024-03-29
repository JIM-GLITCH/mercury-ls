import type{ Diagnostic, Range } from 'vscode-languageserver'
import type{  } from './mercury-parser'
import type{ Token } from './mercury-lexer'
import type{ Document } from './document'
import{ RootNode, Term, termRange } from './term'
import { MercuryDocument } from './document-manager'

export function errorToken(message:string,token:Token,ps:{errors:Diagnostic[]}) {
    let range = tokenRange(token);
    ps.errors.push({
        range,
        message
    })
}
export function errorTerm(message:string,term:Term,ps:{errors:Diagnostic[]}) {
    let range = termRange(term);
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
                ?   (token.text.length-token.text.lastIndexOf("\n")-1)
                :   (token.col+token.text.length-1)
        }
    }
}
export function termTokenRange(term:Term){
    return tokenRange(term.token);
}
export function nameArity(term:Term){
    return term.name+'/'+term.arity;
}
export function showNameArity(term:Term){
    return term.name+'/'+term.arity;
}

export function sleep(ms: number){
    return new Promise(resolve => setTimeout(resolve, ms))
}

export function sameArity(term1:Term,term2:Term){
    return term1.arity == term2.arity;
}
export function sameSemanticType(term1:Term,term2:Term){
    return term1.semanticType == term2.semanticType;
}


export function getDocument(node: Term): MercuryDocument {
    const rootNode = findRootNode(node);
    const result = rootNode.document;
    if (!result) {
        throw new Error('AST node has no document.');
    }
    return result
}

export function findRootNode(node: Term): RootNode {
    while (node.container) {
        node = node.container;
    }
    return node as RootNode;
}