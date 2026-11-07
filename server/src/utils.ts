import type { Diagnostic, Range } from 'vscode-languageserver'
import type { } from './mercury-parser'
import type { Token } from './mercury-lexer'
import type { Document } from './document'
import { RootNode, Term, termRange } from './term'
import { MercuryDocument } from './document-manager'

/** 把模块限定名 Term（可能带 `./2` 链）还原成 `std.array` 这样的点分字符串 */
export function moduleQualifiedName(term: Term): string {
    const parts: string[] = []
    const walk = (t: Term | undefined) => {
        if (!t) return
        if (t.nameArity === './2') {
            walk(t.args[0])
            walk(t.args[1])
            return
        }
        walk(t.qualified)
        parts.push(t.name)
    }
    walk(term)
    return parts.join('.')
}

/** 模块限定名比较：只写末段模块名时按 qualified 链宽松匹配 */
export function equalQualified(term: Term, targetTerm: Term): boolean {
    if (term.name !== targetTerm.name) return false
    if (targetTerm.qualified && term.qualified) {
        return equalQualified(targetTerm.qualified, term.qualified)
    }
    return true
}

export function errorToken(message: string, token: Token, ps: { errors: Diagnostic[] }) {
    let range = tokenRange(token);
    ps.errors.push({
        range,
        message
    })
}
export function errorTerm(message: string, term: Term, ps: { errors: Diagnostic[] }) {
    let range = termRange(term);
    ps.errors.push({
        range,
        message
    })
}

export function tokenRange(token: Token): Range {
    return {
        start: {
            line: token.line - 1,
            character: token.col - 1
        },
        end: {
            line: token.line + token.lineBreaks - 1,
            character: token.lineBreaks
                ? (token.text.length - token.text.lastIndexOf("\n") - 1)
                : (token.col + token.text.length - 1)
        }
    }
}
export function termTokenRange(term: Term) {
    return tokenRange(term.token);
}
/** 语义元数：semanticArity 优先（Type/Arity 写法、DCG +2 的引用），否则回退语法 arity */
export function semanticArityOf(term: Term) {
    return term.semanticArity ?? term.arity;
}
export function semanticNameArityOf(term: Term) {
    return term.name + '/' + semanticArityOf(term);
}


export function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

export function sameArity(term1: Term, term2: Term) {
    return semanticArityOf(term1) == semanticArityOf(term2);
}
export function sameSemanticType(term1: Term, term2: Term) {
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