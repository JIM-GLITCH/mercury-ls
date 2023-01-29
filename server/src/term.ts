// type term = functor|variable

import { Position, Range } from 'vscode-languageserver'
import { Token } from './lexer'
import { MultiMap } from './multimap'
import { SemanticType } from './analyser'
import { tokenRange } from './utils'
import { RefTerm } from './document'

type syntaxType=
    "variable"|
    "atom"|
    "integer"|
    "string"|
    "float"|
    "implementation_defined"

export interface Term {
    /**
     * term 是哪一个module里定义的
     */
    module?: string
    /**
     * syntaxType
     */
    syntaxType:syntaxType
    args: Term[]
    /**which token represents this term */
    token: Token
    /** which token has the smallest position */
    startToken: Token
    /**which token has the largest position */
    endToken: Token
    /**
     *  the term's name
     */
    name: string
    /**  
     *  the term's arity
     */
    arity: number
    /**
     *  semantic type
     */
    semanticType?:SemanticType
    /**
     * the clause this term belong to 
     */
    clause?:clause
    toString():string
}
export class defaultTerm implements Term{
    
    constructor(TermType:syntaxType,token:Token,args:Term[]=[],startToken:Token=token,endToken:Token=token,name:string=token.value){
        this.syntaxType = TermType
        this.token = token;
        this.args = args;
        this.startToken = startToken;
        this.endToken = endToken;
        this.name = name;
        this.arity = args.length
    }
    clause?: clause
    syntaxType:syntaxType
    args: Term[]
    token: Token
    startToken: Token
    endToken: Token
    name: string
    arity: number
    semanticType?: SemanticType | undefined
    toString(): string {
        return termToString(this);
    }
}

export function atom(token:Token,name?:string){
    return new defaultTerm("atom",token,undefined,undefined,undefined,name);
}
export function variable(token:Token){
    let term = new defaultTerm("variable",token);
    term.semanticType ="variable"
    return term
}

export function integer(token:Token){
    return new defaultTerm("integer",token);
}
export function negInteger(token:Token,sign:Token){
    return new defaultTerm("integer",token,[],sign,token,'-'+token.value);
}
export function string(token:Token){
    return new defaultTerm("string",token);
}

export function float(token:Token){
    return new defaultTerm("float",token);
}

export function negFloat(token:Token,sign:Token){
    return new defaultTerm("float",token,[],sign,token,'-'+token.value);
}
export function implementation_defined(token:Token){
    return new defaultTerm("implementation_defined",token);
}

export function binPrefixCompound(token: Token, children: Term[]){
    let node =  new defaultTerm(
        "atom",
        token,
        children,
        token,
        children[children.length-1].endToken);
    fixArity(node);
    return node;

}

export function prefixCompound(token: Token, children: Term[]){
    let node =  new defaultTerm(
        "atom",
        token,
        children,
        token,
        children[children.length - 1].endToken
        );
    fixArity(node);
    return node;

}
export function functorCompound(token: Token, children: Term[],name?:string){
    let node =  new defaultTerm(
        "atom",
        token,
        children,
        token,
        children[children.length - 1].endToken,
        name
    );
    fixArity(node);
    return node;

}
export function applyCompound(token: Token, children: Term[]){
    let node = new defaultTerm(
        "atom",
        token,
        children,
        token,
        children[children.length - 1].endToken
    )
    fixArity(node);
    return node;
}
export function backquotedapplyCompound(token: Token, children: Term[]){
    let node =  new defaultTerm(
        "atom",
        token,
        children,
        children[1].startToken,
        children[children.length - 1].endToken
    )
    fixArity(node);
    return node;
}

export function infixCompound(token: Token, children: Term[], name?:string){
    let node =  new defaultTerm(
        "atom",
        token,
        children,
        children[0].startToken,
        children[children.length - 1].endToken
    )
    fixArity(node);
    return node;
}
 
export class clause  {
    startToken: Token
    endToken: Token
    name: string
	calleeNode!: Term
    calledNodes:RefTerm[]=[]
    defTerm?: Term
    refTerms: Term[]=[]
    search(pos: Position) {
        return checkFunctorRange(pos, this, this.term, undefined)
    }
    range() {
        if (this.term && this.end) {
            return tokenToRange(this.term.startToken, this.end)
        }
        else if (this.term) {
            return tokenToRange(this.term.startToken, this.term.endToken)
        }
        // else if(this.end)
        return tokenToRange(this.end!, this.end!)
    }
    term: Term
    end: Token
    token
    varmap: MultiMap<string, Term>
    constructor(term: Term, end: Token,varmap: MultiMap<string, Term> ) {
        this.term = term
        this.end = end
        this.token = this.end
        this.startToken = term.startToken
        this.endToken = end
        this.name = "clause"
        this.varmap = varmap
        for (const [,varTerms] of varmap.map) {
            varTerms.forEach(v =>v.clause = this);
        }
    }
}

export function tokenToRange(startTk: Token, endTk: Token) {
    return {
        start: {
            line: startTk.line - 1,
            character: startTk.col - 1
        },
        end: {
            line: endTk.line + endTk.lineBreaks - 1,
            character: endTk.lineBreaks
                ? (endTk.text.length - endTk.text.lastIndexOf("\n") - 1)
                : (endTk.col + endTk.text.length - 1)
        }
    }
}
function checkFunctorRange(pos: Position, thisNode: { token: Token }, leftNode?: Term, rightNode?: Term): Term | undefined {
    const functor = thisNode.token
    if (functor == undefined) {
        let node = search(leftNode,pos)
        if (node) return node
        node = search(rightNode,pos)
        if (node) return node
        return undefined

    }
    /**pos 在 functor 左 */
    let range = tokenRange(functor)
    if (range.start.line > pos.line
        || (range.start.line == pos.line && range.start.character > pos.character)) {
        return search(leftNode,pos)
    }
    /**pos 在 functor 右 */
    else if (range.end.line < pos.line
        || (range.end.line == pos.line && range.end.character < pos.character)) {
        return search(rightNode,pos)
    }
    else {
        return thisNode as any
    }
}


function pos_in_range(pos:Position,range:Range){
    if (range.start.line > pos.line
        || (range.start.line == pos.line && range.start.character > pos.character)) {
        return false;
    }
    else if (range.end.line < pos.line
        || (range.end.line == pos.line && range.end.character < pos.character)) {
        return false;
    }
    return true;
}

function binarySearch( terms: Term[],pos: Position,): Term | undefined {
    let low = 0, high = terms.length
    const line = pos.line
    while (low < high) {
        const mid = Math.floor((low + high) / 2)
        const term = terms[mid]
        let range = termRange(term)
        if (range.start.line > pos.line
            || (range.start.line == pos.line && range.start.character > pos.character)) {
            high = mid
        }
        /**pos 在 functor 右 */
        else if (range.end.line < pos.line
            || (range.end.line == pos.line && range.end.character < pos.character)) {
            low = mid + 1
        }
        else {
            return search(term,pos)
        }
    }
}
export function termRange(term: Term) {
    return tokenToRange(term.startToken, term.endToken)
}
// 每一个 state variable 例如 !X 占两个参数位置
function fixArity(node:Term){
    for (const arg of node.args) {
        if(arg.name == "!" && arg.arity==1&&arg.args[0].token.type=="variable"){
            node.arity++;
        }
    }
}
/**
 * 
 * @param term search position in this term
 * @param pos postition  to find a term
 * @returns  term at the postion or undefined
 */
function search(term: Term | undefined, pos: Position): Term | undefined {
    switch(term?.syntaxType){
        case "atom":{
            let token_range = tokenRange(term.token);
            if(pos_in_range(pos,token_range)){
                return term;              
            }
            return binarySearch(term.args,pos);
        }
        case "float":
        case "implementation_defined":
        case "integer":
        case "string":
        case "variable":{
            let term_range = termRange(term)
            if(pos_in_range(pos,term_range)){
               return term 
            }
            return undefined;
        }
    } 
}
function termToString(term: Term) {
    switch(term.syntaxType){
        case 'atom':{
            if(term.args.length == 0){
                return term.name;
            }
            let argsString  = term.args.map(x=>x.toString()).join()
            return `${term.name}(${argsString})`
        }
        case 'string':
        case 'variable':
        case 'integer':
        case 'float':
        case 'implementation_defined':{
            return term.name;
        }
    }
}

