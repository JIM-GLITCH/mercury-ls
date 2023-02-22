// type term = functor|variable

import { Location, Position, Range } from 'vscode-languageserver'
import { Token } from './lexer'
import { MultiMap } from './multimap'
import { SemanticType } from './analyser'
import { tokenRange } from './utils'
import { Document, RefTerm } from './document'

type SyntaxType=
    "variable"|
    "atom"|
    "integer"|
    "string"|
    "float"|
    "implementation_defined"

export interface Term {
    /** 
     * The index in args in the container 
     * */
    index?:number
    container?:Term
    /**
     * term 是哪一个module里定义的 find definition reference 时用到
     */
    module?: string
    /**
     * syntaxType
     */
    syntaxType:SyntaxType
    /**
     * term's subterms
     */
    args: Term[]
    /**which token represents this term */
    token: Token
    /** which token has the smallest position */
    startToken: Token
    /**which token has the largest position */
    endToken: Token
    /**
     *  this term's name
     */
    name: string
    /**  
     *  this term's arity
     */
    arity: number
    /**
     *  语义类型 provide hover时 find definition reference 时用到
     */
    semanticType?:SemanticType
    /**
     * the clause this term belong to 
     */
    clause?:Clause
    /**
     * 
     * @param depth debug时 打印term args的深度
     */
    toString(depth?:number):string
}
export class TermImpl implements Term{
    semanticType?: SemanticType 
    
    constructor(TermType:SyntaxType,token:Token,args:Term[]=[],startToken:Token=token,endToken:Token=token,name:string=token.value){
        this.syntaxType = TermType
        this.token = token;
        this.args = args;
        this.startToken = startToken;
        this.endToken = endToken;
        this.name = name;
        this.arity = args.length
        args.forEach((x,index)=>{
            x.container = this
            x.index = index
        })
    }
    module?: string | undefined
    clause?: Clause
    syntaxType:SyntaxType
    args: Term[]
    token: Token
    startToken: Token
    endToken: Token
    name: string
    arity: number
    toString(depth=1): string {
        return termToString(this,depth);
    }
}

export function atom(token:Token,name?:string){
    return new TermImpl("atom",token,undefined,undefined,undefined,name);
}
export function variable(token:Token){
    let term = new TermImpl("variable",token);
    term.semanticType ="variable"
    return term
}

export function integer(token:Token){
    return new TermImpl("integer",token);
}
export function negInteger(token:Token,sign:Token){
    return new TermImpl("integer",token,[],sign,token,'-'+token.value);
}
export function string(token:Token){
    return new TermImpl("string",token);
}

export function float(token:Token){
    return new TermImpl("float",token);
}

export function negFloat(token:Token,sign:Token){
    return new TermImpl("float",token,[],sign,token,'-'+token.value);
}
export function implementation_defined(token:Token){
    return new TermImpl("implementation_defined",token);
}

export function binPrefixCompound(token: Token, children: Term[]){
    let node =  new TermImpl(
        "atom",
        token,
        children,
        token,
        children[children.length-1].endToken
    );
    fixArity(node);
    return node;

}

export function prefixCompound(token: Token, children: Term[]){
    let node =  new TermImpl(
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
    let node =  new TermImpl(
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
    let node = new TermImpl(
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
    let node =  new TermImpl(
        "atom",
        token,
        children,
        children[0].startToken,
        children[1].endToken
    )
    fixArity(node);
    return node;
}

export function infixCompound(token: Token, children: Term[], name?:string){
    let node =  new TermImpl(
        "atom",
        token,
        children,
        children[0].startToken,
        children[children.length - 1].endToken
    )
    fixArity(node);
    return node;
}
/**
 * clause 
 */
export class Clause {
    startToken: Token
    endToken: Token
    name: string
	calleeNode?: Term
    calledNodes:RefTerm[]=[]
    search(pos: Position) {
        return search(this.term,pos);
    }
    range() {
        if (this.term && this.end) {
            return StartEndTokenToRange(this.term.startToken, this.end)
        }
        else if (this.term) {
            return StartEndTokenToRange(this.term.startToken, this.term.endToken)
        }
        // else if(this.end)
        return StartEndTokenToRange(this.end!, this.end!)
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
        for (const [,varTerms] of varmap.entriesGroupedByKey()) {
            varTerms.forEach(v =>v.clause = this);
        }
        term.index = 0;
    }
    toString(){
        return this.term.toString()+".";
    }
}
/**
 * 将 startToken 和 endToken 转化为 Range
 * @param startToken startToken提供Range.start
 * @param endToken endToken提供Range.end
 * @returns Range
 */
export function StartEndTokenToRange(startToken: Token, endToken: Token):Range {
    return {
        start: {
            line: startToken.line - 1,
            character: startToken.col - 1
        },
        end: {
            line: endToken.line + endToken.lineBreaks - 1,
            character: endToken.lineBreaks
                ? (endToken.text.length - endToken.text.lastIndexOf("\n") - 1)
                : (endToken.col + endToken.text.length - 1)
        }
    }
}

/**
 * 判断position是否在range内
 * @param position 
 * @param range 
 * @returns 
 */
function positionInRange(position:Position,range:Range){
    if (range.start.line > position.line
        || (range.start.line == position.line && range.start.character > position.character)) {
        return false;
    }
    else if (range.end.line < position.line
        || (range.end.line == position.line && range.end.character <= position.character)) {
        return false;
    }
    return true;
}


/**
 * 得到term的位置范围 range
 * @param term term
 * @returns 
 */
export function termRange(term: Term):Range {
    return StartEndTokenToRange(term.startToken, term.endToken)
}

/**
 * 将语法上的arity修正为语义上的arity,
 * 每一个 state variable 例如 !X 语义上占两个参数位置
 * @param term 
 */
function fixArity(term:Term){
    for (const arg of term.args) {
        if(arg.name == "!" && arg.arity==1&&arg.args[0].token.type=="variable"){
            term.arity++;
        }
    }
}
/**
 * 在term的范围内查找位置为position的term或subterm
 * @param term search position in this term
 * @param position postition to find a term
 * @returns  term at the postion or undefined
 */
function search(term: Term | undefined, position: Position): Term | undefined {
    switch(term?.syntaxType){
        case "atom":{
            let token_range = tokenRange(term.token);
            if(positionInRange(position,token_range)){
                return term;              
            }
            for (const arg of term.args) {
                let res = search(arg,position);
                if(res) return res;
            }
        }
        case "float":
        case "implementation_defined":
        case "integer":
        case "string":
        case "variable":{
            let term_range = termRange(term)
            if(positionInRange(position,term_range)){
               return term 
            }
            return undefined;
        }
    } 
}
/**
 * 把term转换成string
 * @param term 要打印的term
 * @param depth 当前打印args的深度
 * @returns 
 */
function termToString(term: Term,depth:number=1) {
    if(depth>3){
        return " ... ";
    }
    switch(term.syntaxType){
        case 'atom':{
            if(term.args.length == 0){
                return term.name;
            }
            let argsString  = term.args.map(x=>x.toString(depth+1)).join(', ')
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

