/******************************************************************************
 * CHR_Rule 的数组骨架语法
 *
 * token 用字符串字面量，约束用 [...] 包成一组，值直接内联，不再需要 :N 占位符和值字典：
 *
 *   CHR_Rule(['name', '@', ['a'], '\\', ['c'], '<=>', ['b']])   simpagation
 *   CHR_Rule([['a', 'b'], '<=>', ['c']])                        simplification，省略名字
 *   CHR_Rule(['name', '@', ['a'], '==>', ['b']])                propagation
 *   CHR_Rule([['a'], '<=>', () => true, '|', ['b']])            带 guard
 *
 * - 规则名只能是第一个元素且后跟 '@'；名字与 '@' 可整个省略（'@' 前留空也算省略）。
 * - 约束段是 [...] 包起来的一组约束，元素任意（字符串、对象、含逻辑变量的项都可以），
 *   同一段可以有多个 [...] 累加。
 * - '\' 分隔 kept / removed head，只配 '<=>'；'=>' 只用于 propagation。
 * - guard 省略时 '|' 一起省略，op 后直接是 body；有 '|' 时 '|' 前最多一个 guard 函数、
 *   '|' 后是 body。body 段若恰好只有一个函数，作为自定义 body。
 * - const A 保留元组与字面量 token，ParseRuleArray 在编译期检查语法、推导 kind；
 *   运行时 parseRuleArray 只按同一套结构切段，不校验、不抛错。
 ******************************************************************************/

export type CHROperator = 'simplification' | 'propagation' | 'simpagation'
export type RuleSyntaxError<M extends string> = { readonly __CHR_Rule_error__: M }

type Terms = readonly unknown[]
type Fn = (...args: any[]) => any
type Op = '<=>' | '==>'

export interface CHRRuleShape {
    name: string
    kind: CHROperator
    kept: unknown[]
    removed: unknown[]
    guard: Fn | undefined
    customBody: Fn | undefined
    bodies: unknown[]
}

const isOp = (x: unknown): x is Op => x === '<=>' || x === '==>'

/** 运行时按 token 切段；类型层已保证语法合法，这里不校验、不抛错。 */
export function parseRuleArray(src: readonly unknown[]): CHRRuleShape {
    let i = 0
    let name = ''
    if (typeof src[0] === 'string' && src[1] === '@') { name = src[0]; i = 2 }
    else if (src[0] === '@') { i = 1 }

    const rest = src.slice(i)
    const opAt = rest.findIndex(isOp)
    const op: Op = isOp(rest[opAt]) ? rest[opAt] : '<=>'
    const before = opAt >= 0 ? rest.slice(0, opAt) : rest
    const after = opAt >= 0 ? rest.slice(opAt + 1) : []

    const slash = before.indexOf('\\')
    const keptPart = slash >= 0 ? before.slice(0, slash) : before
    const removedPart = slash >= 0 ? before.slice(slash + 1) : []

    const pipe = after.indexOf('|')
    const guardPart = pipe >= 0 ? after.slice(0, pipe) : []
    const bodyPart = pipe >= 0 ? after.slice(pipe + 1) : after

    const terms = (part: readonly unknown[]): unknown[] => {
        const out: unknown[] = []
        for (const x of part) if (Array.isArray(x)) out.push(...x)
        return out
    }
    const guard = guardPart.find((x): x is Fn => typeof x === 'function')
    const bodyTerms = terms(bodyPart)
    const customBody = bodyTerms.length === 1 && typeof bodyTerms[0] === 'function'
        ? bodyTerms[0] as Fn
        : undefined

    const kind: CHROperator = slash >= 0
        ? 'simpagation'
        : op === '==>' ? 'propagation' : 'simplification'

    return {
        name, kind,
        kept: terms(keptPart),
        removed: terms(removedPart),
        guard, customBody,
        bodies: customBody ? [] : bodyTerms,
    }
}

/******************************************************************************
 * 类型层：把元组按 token 切成 name / heads / op / guard / body 五段后逐一校验
 ******************************************************************************/
type StripName<A extends readonly unknown[]> =
    A extends readonly [infer N, '@', ...infer R]
        ? N extends string ? R : RuleSyntaxError<'rule name must be a string'>
        : A extends readonly ['@', ...infer R] ? R
        : A

type SplitOp<A extends readonly unknown[], Acc extends unknown[] = []> =
    A extends readonly [infer H, ...infer R]
        ? H extends Op ? [Acc, H, R] : SplitOp<R, [...Acc, H]>
        : RuleSyntaxError<'missing rule operator (<=> / ==>)'>

type SplitSlash<A extends readonly unknown[], Acc extends unknown[] = []> =
    A extends readonly [infer H, ...infer R]
        ? H extends '\\' ? [Acc, R] : SplitSlash<R, [...Acc, H]>
        : [Acc, undefined]

type SplitPipe<A extends readonly unknown[], Acc extends unknown[] = []> =
    A extends readonly [infer H, ...infer R]
        ? H extends '|' ? [Acc, R] : SplitPipe<R, [...Acc, H]>
        : [undefined, Acc]

/** 段里的元素只能是 [...] 约束列表；裸字符串 token 或裸函数在这里都会被拦下。 */
type AllTermLists<A extends readonly unknown[]> =
    A extends readonly [infer H, ...infer R]
        ? H extends Terms ? AllTermLists<R> : RuleSyntaxError<'expected a constraint list [...]'>
        : unknown

type HasConstraint<A extends readonly unknown[]> =
    A extends readonly [infer H, ...infer R]
        ? H extends Terms ? (H extends readonly [] ? HasConstraint<R> : true) : HasConstraint<R>
        : false

type CheckGuard<A extends readonly unknown[]> =
    A extends readonly [] ? unknown
    : A extends readonly [infer G]
        ? G extends Fn ? unknown : RuleSyntaxError<'guard must be a function'>
        : RuleSyntaxError<'only one guard is allowed before |'>

type Finish<G, B extends readonly unknown[], K extends CHROperator> =
    AllTermLists<B> extends RuleSyntaxError<string> ? AllTermLists<B>
    : G extends undefined ? { kind: K }
    : G extends readonly unknown[]
        ? CheckGuard<G> extends RuleSyntaxError<string> ? CheckGuard<G> : { kind: K }
    : { kind: K }

type CheckParts<
    K extends readonly unknown[], D, G, B extends readonly unknown[], O extends Op,
> =
    AllTermLists<K> extends RuleSyntaxError<string> ? AllTermLists<K>
    : HasConstraint<K> extends false ? RuleSyntaxError<'rule needs at least one head'>
    : D extends readonly unknown[]
        ? AllTermLists<D> extends RuleSyntaxError<string> ? AllTermLists<D>
        : HasConstraint<D> extends false ? RuleSyntaxError<'simpagation needs a removed head'>
        : O extends '<=>' ? Finish<G, B, 'simpagation'> : RuleSyntaxError<'\\ requires <=>'>
    : Finish<G, B, O extends '==>' ? 'propagation' : 'simplification'>

export type ParseRuleArray<A extends readonly unknown[]> =
    StripName<A> extends infer R extends readonly unknown[]
        ? SplitOp<R> extends readonly [
            infer Before extends readonly unknown[], infer O extends Op, infer After extends readonly unknown[],
        ]
            ? SplitSlash<Before> extends readonly [infer K extends readonly unknown[], infer D]
                ? SplitPipe<After> extends readonly [infer G, infer B extends readonly unknown[]]
                    ? CheckParts<K, D, G, B, O>
                    : never
                : never
            : SplitOp<R>
        : StripName<A>

/** 骨架不合法时参数变成 A & RuleSyntaxError<...>，在写规则的地方直接报编译错误。 */
export type ValidateRuleArray<A extends readonly unknown[]> =
    ParseRuleArray<A> extends RuleSyntaxError<string> ? ParseRuleArray<A> : unknown

/** 类型层推导出的规则种类。 */
export type RuleKindOfArray<A extends readonly unknown[]> =
    ParseRuleArray<A> extends { kind: infer K extends CHROperator } ? K : CHROperator
