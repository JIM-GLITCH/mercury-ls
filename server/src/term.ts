// type term = functor|variable

import { Location, Position, Range } from 'vscode-languageserver'
import { Token } from './mercury-lexer'
import { MultiMap } from './multimap'
import { SemanticType } from "./document-visitor"
import { tokenRange } from './utils'
import { Document, RefTerm } from './document'
import { MercuryDocument } from './document-manager'

type SyntaxType =
    "variable" |
    "atom" |
    "integer" |
    "string" |
    "float" |
    "implementation_defined" |
    '$clause'|
    '$rootNode'


export interface Term {
    definition?: Term
    qualified?: Term
    /** The container node in the AST; every node except the root node has a container. */
    container?: Term
    /** 
     * The index in args in the container 
     * */
    containerIndex?: number
    /**
     * syntaxType
     */
    syntaxType: SyntaxType
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
    nameArity:string
    /**
     *  语义类型 provide hover时 find definition reference 时用到
     */
    semanticType?: SemanticType
    /**
     * the clause this term belong to 
     */
    clause?: Clause
    document?:MercuryDocument
    /**
     * 
     * @param depth debug时 打印term args的深度
     */
    toString(depth?: number): string
    range:Range
}
export class TermImpl implements Term {
    semanticType?: SemanticType
    nameArity:string
    constructor(TermType: SyntaxType, token: Token, args: Term[] = [], startToken: Token = token, endToken: Token = token, name: string = token.value) {
        this.syntaxType = TermType
        this.token = token
        this.args = args
        this.startToken = startToken
        this.endToken = endToken
        this.name = name
        this.arity = args.length
        this.nameArity = this.name +'/'+ this.arity
        args.forEach((x, index) => {
            x.container = this
            x.containerIndex = index
        })
    }
    arity:number
    name:string
    
    document?: MercuryDocument | undefined
    get range():Range {
        return termRange(this);
    }
    container?: Term | undefined
    containerIndex?: number | undefined
    module?: string | undefined
    clause?: Clause
    syntaxType: SyntaxType
    args: Term[]
    token: Token
    startToken: Token
    endToken: Token
    toString(depth = 1): string {
        return termToString(this, depth)
    }
    qualified?: Term;
}

export function atom(token: Token, name?: string) {
    return new TermImpl("atom", token, undefined, undefined, undefined, name)
}
export function variable(token: Token) {
    let term = new TermImpl("variable", token)
    term.semanticType = "variable"
    return term
}

export function integer(token: Token) {
    return new TermImpl("integer", token)
}
export function negInteger(token: Token, sign: Token) {
    return new TermImpl("integer", token, [], sign, token, '-' + token.value)
}
export function string(token: Token) {
    return new TermImpl("string", token)
}

export function float(token: Token) {
    return new TermImpl("float", token)
}

export function negFloat(token: Token, sign: Token) {
    return new TermImpl("float", token, [], sign, token, '-' + token.value)
}
export function implementation_defined(token: Token) {
    return new TermImpl("implementation_defined", token)
}

export function binPrefixCompound(token: Token, children: Term[]) {
    let node = new TermImpl(
        "atom",
        token,
        children,
        token,
        children[children.length - 1].endToken
    )
    fixArity(node)
    return node

}

export function prefixCompound(token: Token, children: Term[]) {
    let node = new TermImpl(
        "atom",
        token,
        children,
        token,
        children[children.length - 1].endToken
    )
    fixArity(node)
    return node

}
export function functorCompound(token: Token, children: Term[], name?: string) {
    let node = new TermImpl(
        "atom",
        token,
        children,
        token,
        children[children.length - 1].endToken,
        name
    )
    fixArity(node)
    return node

}
export function applyCompound(token: Token, children: Term[]) {
    let node = new TermImpl(
        "atom",
        token,
        children,
        token,
        children[children.length - 1].endToken
    )
    fixArity(node)
    return node
}
export function backquotedapplyCompound(token: Token, children: Term[]) {
    let node = new TermImpl(
        "atom",
        token,
        children,
        children[0].startToken,
        children[1].endToken
    )
    fixArity(node)
    return node
}

export function infixCompound(token: Token, children: Term[], name?: string) {
    let node = new TermImpl(
        "atom",
        token,
        children,
        children[0].startToken,
        children[children.length - 1].endToken
    )
    fixArity(node)
    return node
}
/**
 * clause 
 */

export class Clause extends TermImpl {
    term: Term
    end: Token
    varMap: MultiMap<string, Term>= new MultiMap()
    callee?: Term
    called = new Array<Term>()
    constructor(term: Term, end: Token, varmap: MultiMap<string, Term>) {
        super("$clause",end,[term],term.startToken,end);
        this.term = term
        this.end = end
        this.varMap = varmap
        for (const [, varTerms] of varmap.entriesGroupedByKey()) {
            varTerms.forEach(v => v.clause = this)
        }
        this.syntaxType = "$clause"
    }

    syntaxType: SyntaxType
    toString() {
        return this.term.toString() + "."
    }
}

export class RootNode extends TermImpl {
    constructor(clauses:Clause[]){
        let token:Token = {
            type:"EOF",
            line:0,
            col:0,
            value:"",
            text:"",
            offset:-1,
            lineBreaks:0
        }
        super("$rootNode",token,clauses)
    }
    declare args:Clause[]
    
}
/**
 * 将 startToken 和 endToken 转化为 Range
 * @param startToken startToken提供Range.start
 * @param endToken endToken提供Range.end
 * @returns Range
 */
export function StartEndTokenToRange(startToken: Token, endToken: Token): Range {
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
function positionInRange(position: Position, range: Range) {
    if (range.start.line > position.line
        || (range.start.line == position.line && range.start.character > position.character)) {
        return false
    }
    else if (range.end.line < position.line
        || (range.end.line == position.line && range.end.character <= position.character)) {
        return false
    }
    return true
}


/**
 * 得到term的位置范围 range
 * @param term term
 * @returns 
 */
export function termRange(term: Term): Range {
    return StartEndTokenToRange(term.startToken, term.endToken)
}

/**
 * 将语法上的arity修正为语义上的arity,
 * 每一个 state variable 例如 !X 语义上占两个参数位置
 * @param term 
 */
function fixArity(term: Term) {
    for (const arg of term.args) {
        if (arg.name == "!" && arg.arity == 1 && arg.args[0].token.type == "variable") {
            term.arity++
        }
    }
    term.nameArity = term.name +'/'+ term.arity
}
/**
 * 在term的范围内查找位置为position的term或subterm
 * @param term search position in this term
 * @param position postition to find a term
 * @returns  term at the postion or undefined
 */
export function search(term: Term | undefined, position: Position): Term | undefined {
    switch (term?.syntaxType) {
        case "$rootNode":{
            let clauses = (term as RootNode).args
            let low = 0, high =clauses.length-1;
            const line = position.line;
            while (low <= high){
                const mid = Math.floor((low + high)/2)
                const clause = clauses[mid];
                let clauseRange = clause.range;
                if (clauseRange.start.line>line){
                    high = mid-1;
                }
                else if(clauseRange.end.line<line){
                    low = mid + 1;
                }
                else{
                        return search(clause,position);

                }
            }
            break;
        }
        case "$clause":
        case "atom": {
            let token_range = tokenRange(term.token)
            if (positionInRange(position, token_range)) {
                return term
            }
            for (const arg of term.args) {
                let res = search(arg, position)
                if (res) return res
            }
            break;
        }
        case "float":
        case "implementation_defined":
        case "integer":
        case "string":
        case "variable": {
            let term_range = termRange(term)
            if (positionInRange(position, term_range)) {
                return term
            }
            return undefined
        }
    }
}
/**
 * 把term转换成string
 * @param term 要打印的term
 * @param depth 当前打印args的深度
 * @returns 
 */
function termToString(term: Term, depth: number = 1) {
    if (depth > 3) {
        return " ... "
    }
    switch (term.syntaxType) {
        case 'atom': {
            if (term.args.length == 0) {
                return term.name
            }
            let argsString = term.args.map(x => x.toString(depth + 1)).join(', ')
            return `${term.name}(${argsString})`
        }
        default:
            return  term.name
    }
}

