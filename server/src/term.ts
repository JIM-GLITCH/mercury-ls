// type term = functor|variable

import { Position } from 'vscode-languageserver'
import { Token, tokenRange } from './lexer'
import { MultiMap } from './multimap'

export type TermKind =
    variable | atom | integer | str | float | negInteger | negFloat | implementation_defined | binPrefixCompound | prefixCompound | functorCompound
export interface Term {
    args: Term[]
    /**which token represents this term */
    token: Token
    /** which token has the smallest position */
    startToken: Token
    /**which token has the largest position */
    endToken: Token
    /**find the Term by position */
    search(pos: Position): Term | undefined
    /**
     *  for hover
     */
    val: string
    arity: number
}
export class variable implements Term {
    token
    startToken: Token
    endToken: Token
    arity=0
    constructor(token: Token) {
        this.token = token
        this.startToken = token
        this.endToken = token
        this.val = token.value
    }
    args: Term[]=[]
    val: string
    search(pos: Position) {
        return checkFunctorRange(pos, this, undefined, undefined)
    }
}

export class atom implements Term {
    token: Token
    val: string
    arity=0
    constructor(token: Token, val: string = token.value) {
        this.token = token
        this.val = val
        this.startToken = token
        this.endToken = token
    }
    args: Term[]=[]
    startToken: Token
    endToken: Token
    search(pos: Position) {
        return checkFunctorRange(pos, this, undefined, undefined)
    }

}
export class integer implements Term {
    token: Token
    arity=0
    constructor(token: Token,) {
        this.token = token
        this.startToken = token
        this.endToken = token
        this.val = token.value

    }
    args: Term[]=[]
    val: string
    startToken: Token
    endToken: Token
    search(pos: Position) {
        return checkFunctorRange(pos, this, undefined, undefined)
    }
}
export class str implements Term {
    token: Token
    arity=0
    constructor(token: Token,) {
        this.token = token
        this.startToken = token
        this.endToken = token
        this.val = token.value

    }
    args: Term[]=[]
    val: string
    startToken: Token
    endToken: Token
    search(pos: Position) {
        return checkFunctorRange(pos, this, undefined, undefined)
    }
}
export class float implements Term {
    token: Token
    arity=0
    constructor(token: Token) {
        this.token = token
        this.startToken = token
        this.endToken = token
        this.val = token.value

    }
    args: Term[]=[]
    val: string
    startToken: Token
    endToken: Token
    search(pos: Position) {
        return checkFunctorRange(pos, this, undefined, undefined)
    }
}

export class negInteger implements Term {
    sign: Token
    token: Token
    arity=0
    constructor(token: Token, sign: Token) {
        this.token = token
        this.sign = sign
        this.startToken = sign
        this.endToken = token
        this.val = token.value

    }
    args: Term[]=[]
    val: string
    startToken: Token
    endToken: Token
    search(pos: Position) {
        return checkFunctorRange(pos, this, undefined, undefined)
    }
}
export class negFloat implements Term {
    sign: Token
    token: Token
    arity=0
    constructor(token: Token, sign: Token) {
        this.token = token
        this.sign = sign
        this.startToken = sign
        this.endToken = token
        this.val = token.value

    }
    args: Term[]=[]
    val: string
    startToken: Token
    endToken: Token
    search(pos: Position) {
        return checkFunctorRange(pos, this, undefined, undefined)
    }
}
export class implementation_defined implements Term {
    token: Token
    arity=0
    constructor(token: Token,) {
        this.token = token
        this.startToken = token
        this.endToken = token
        this.val = token.value

    }
    args: Term[]=[]
    val: string
    startToken: Token
    endToken: Token
    search(pos: Position) {
        return checkFunctorRange(pos, this, undefined, undefined)
    }
}
export class binPrefixCompound implements Term {
    token: Token
    args: Term[]
    arity=2
    constructor(token: Token, children: Term[]) {
        this.token = token
        this.args = children
        this.startToken = token
        this.endToken = children[1].endToken
        this.val = token.value

    }
    val: string
    startToken: Token
    endToken: Token
    search(pos: Position) {
        return checkFunctorRange(pos, this, undefined, undefined)
            ?? binearySearch(pos, this.args)
    }
}

export class prefixCompound implements Term {
    token: Token
    arity: number
    constructor(token: Token, children: Term[]) {
        this.token = token
        this.args = children
        this.startToken = token
        this.endToken = children[0].endToken
        this.val = token.value
        this.arity = children.length

    }
    args: Term[]=[]
    val: string
    startToken: Token
    endToken: Token
    search(pos: Position) {
        return checkFunctorRange(pos, this, undefined, undefined)
            ?? binearySearch(pos, this.args)
    }
}


export class functorCompound implements Term {
    token: Token
    val: string
    args: Term[]
    arity:number 
    constructor(token: Token, children: Term[], val: string = token.value) {
        this.token = token
        this.args = children
        this.val = val
        this.startToken = token
        this.endToken = children[children.length - 1].endToken
        this.arity = children.length;
    }
    startToken: Token
    endToken: Token
    search(pos: Position) {
        return checkFunctorRange(pos, this, undefined, undefined)
            ?? binearySearch(pos, this.args)
    }
}

export class applyTerm implements Term {
    token: Token
    val = "";
    args
    arity: number
    constructor(token: Token, children: Term[]) {
        this.token = token
        this.args = children
        this.startToken = children[0].startToken
        this.endToken = children[children.length - 1].endToken
        this.arity = children.length;

    }
    startToken: Token
    endToken: Token
    search(pos: Position) {
        return checkFunctorRange(pos, this, undefined, undefined)
            ?? binearySearch(pos, this.args)
    }
}
export class backquotedapplyTerm implements Term {
    token: Token
    startToken: Token
    endToken: Token
    args: Term[]
    arity: number
    constructor(token: Token, children: Term[]) {
        this.token = token
        this.startToken = children[1].startToken
        this.endToken = children[children.length - 1].endToken
        this.args = children
        this.val = token.value
        this.arity = children.length;

    }
    val: string
    search(pos: Position) {
        return checkFunctorRange(pos, this, undefined, undefined)
            ?? binearySearch(pos, this.args)
    }
}
export class infixCompound implements Term {
    token: Token
    val: string
    args: Term[]
    arity = 2

    constructor(token: Token, children: Term[], val: string = token.value) {
        this.token = token
        this.args = children
        this.val = val
        this.startToken = children[0].startToken
        this.endToken = children[children.length - 1].endToken
    }
    startToken: Token
    endToken: Token
    search(pos: Position) {
        return checkFunctorRange(pos, this, this.args[0], this.args[1])
    }
}

export class clause  {
    startToken: Token
    endToken: Token
    val: string
	callerNode!: Term
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
    varmap!: MultiMap<string, Term>
    constructor(term: Term, end: Token) {
        this.term = term
        this.end = end
        this.token = this.end
        this.startToken = term.startToken
        this.endToken = end
        this.val = "clause"
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
        let node = leftNode?.search(pos)
        if (node) return node
        node = rightNode?.search(pos)
        if (node) return node
        return undefined

    }
    /**pos 在 functor 左 */
    let range = tokenRange(functor)
    if (range.start.line > pos.line
        || (range.start.line == pos.line && range.start.character > pos.character)) {
        return leftNode?.search(pos)
    }
    /**pos 在 functor 右 */
    else if (range.end.line < pos.line
        || (range.end.line == pos.line && range.end.character < pos.character)) {
        return rightNode?.search(pos)
    }
    else {
        return thisNode as any
    }
}

function binearySearch(pos: Position, terms: Term[]): Term | undefined {
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
            return term.search(pos)
        }
    }
}
export function termRange(term: Term) {
    return tokenToRange(term.startToken, term.endToken)
}