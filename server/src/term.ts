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
    '$clause' |
    '$rootNode'


/**
 * 记录语法（record syntax）`^` 处的字段说明符（Mercury: field specifier）与
 * 它展开成的字段访问函数（field access function）的派生名字/元数。
 * `A ^ elem(I)`     → `elem(I, A)`        （field selection function, N+1）
 * `A ^ elem(I) := V` → `'elem :='(I, A, V)`（field update function,    N+2）
 */
export interface FieldAccessInfo {
    base: string                       // 字段名 elem
    specArity: number                  // 字段说明符的参数个数 N
    role: 'select' | 'update'
    selectionName: string              // elem
    selectionArity: number             // N + 1
    updateName: string                 // elem :=（源码里写作 'elem :='）
    updateArity: number                // N + 2
}

export interface Term {
    fieldAccess?: FieldAccessInfo
    definition?: Term
    /** 模块限定前缀的点分名（'io.stream_ops'）；undefined = 无限定。统一用字符串，不存 Term 链 */
    qualified?: string
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
    /**
     *  语义元数：语法上是 0 元原子、但按 Type/Arity 写法语义上带参的引用
     *  （如 `inst I for diet/1` 里 diet 的 arity 是 0，semanticArity 是 1）。
     *  hover 与定义/引用查找按此字段显示与匹配，未设置时回退 arity
     */
    semanticArity: number
    /**
     *  CST name/arity
     */
    nameArity: string
    /**
     *  语义类型 provide hover时 find definition reference 时用到
     */
    semanticType?: SemanticType
    /**
     * the clause this term belong to 
     */
    clause?: Clause
    document?: MercuryDocument
    /**
     * 
     * @param depth debug时 打印term args的深度
     */
    toString(depth?: number): string
    range: Range
}
export class TermImpl implements Term {
    fieldAccess?: FieldAccessInfo
    semanticType?: SemanticType
    semanticArity: number
    nameArity: string
    constructor(TermType: SyntaxType, token: Token, args: Term[] = [], startToken: Token = token, endToken: Token = token, name: string = token.value) {
        this.syntaxType = TermType
        this.token = token
        this.args = args
        this.startToken = startToken
        this.endToken = endToken
        this.name = name
        this.arity = args.length
        this.semanticArity = this.arity
        this.nameArity = this.name + '/' + this.arity
        args.forEach((x, index) => {
            x.container = this
            x.containerIndex = index
        })
    }
    arity: number
    name: string

    document?: MercuryDocument | undefined
    get range(): Range {
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
    qualified?: string;
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
        children[children.length - 1].endToken,
        name
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
    varMap: MultiMap<string, Term> = new MultiMap()
    callee?: Term
    called = new Array<Term>()
    constructor(term: Term, end: Token, varmap: MultiMap<string, Term>) {
        super("$clause", end, [term], term.startToken, end);
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
    constructor(clauses: Clause[]) {
        let token: Token = {
            type: "EOF",
            line: 0,
            col: 0,
            value: "",
            text: "",
            offset: -1,
            lineBreaks: 0
        }
        super("$rootNode", token, clauses)
    }
    declare args: Clause[]

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
            term.semanticArity++
        }
    }
}
/**
 * 在term的范围内查找位置为position的term或subterm
 * @param term search position in this term
 * @param position postition to find a term
 * @returns  term at the postion or undefined
 */
export function search(term: Term | undefined, position: Position): Term | undefined {
    switch (term?.syntaxType) {
        case "$rootNode": {
            let clauses = (term as RootNode).args
            let low = 0, high = clauses.length - 1;
            const line = position.line;
            while (low <= high) {
                const mid = Math.floor((low + high) / 2)
                const clause = clauses[mid];
                let clauseRange = clause.range;
                if (clauseRange.start.line > line) {
                    high = mid - 1;
                }
                else if (clauseRange.end.line < line) {
                    low = mid + 1;
                }
                else {
                    return search(clause, position);

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
// ===== 模块限定名（qualified name）的唯一工具 =====
// 统一用点分字符串表示：Term.qualified 存的是限定前缀（'io.stream_ops'，
// 不含名字本身）；moduleQualifiedName 把任意 Term 形态归一成 'a.b.c'。
// 源码里的 './2' 左结合链（.(.(a,b),c)）只存在于 parse 树，visit 阶段
// 由 visitQualifiedTerm/visitQualifiedModule 解包并把前缀写成字符串。

/** 任意形态的模块限定名 → 'a.b.c' 点分串（裸原子 → 'a'；已规范化项 → 前缀.名） */
export function moduleQualifiedName(term: Term): string {
    if (term.nameArity === './2') {
        // 原始 './2' 链：args[0] 是前缀、args[1] 是本段名（不看其 .qualified，避免重复计数）
        return `${moduleQualifiedName(term.args[0])}.${term.args[1].name}`
    }
    return term.qualified ? `${term.qualified}.${term.name}` : term.name
}

/** 模块限定名相等性：按点分名比较（'./2' 链与规范化形态视为等价） */
export function equalQualified(term: Term, targetTerm: Term): boolean {
    return moduleQualifiedName(term) === moduleQualifiedName(targetTerm)
}

/**
 * 把 prefix 模块的点分名补到 term.qualified 最前（原地修改）。
 * include_module 声明的是当前模块的子模块、名字可免全限定
 * （module io 里的 stream_ops = io.stream_ops）：visit 侧统一补成
 * 绝对限定名，消费方（moduleManager.get / equalQualified）无需感知相对解析。
 */
export function prependModuleQualifier(term: Term, prefix: Term): void {
    const p = moduleQualifiedName(prefix)
    term.qualified = term.qualified ? `${p}.${term.qualified}` : p
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
            return term.name
    }
}

