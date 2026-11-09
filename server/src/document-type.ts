import { Term } from './term'
import type { MerModeRef } from './document-mode'

// 轻量类型表示（对应编译器 mer_type），仅用于 LSP 级消歧，不含 kind / 类型类约束
export type MerType =
    | { kind: 'typeVar'; name: string; bind: MerType }
    | { kind: 'typeConstructor'; name: string, args: MerType[]; result: MerType }
    | { kind: 'pred'; name: string, args: MerType[] }
    | { kind: 'func'; name: string, args: MerType[]; result?: MerType }
    | { kind: "type", name: string }



// 一条过程 mode（对应编译器一个 procedure）：:- mode P(Modes) [is Det]. 或 :: 注解推出的默认过程
export interface ProcMode {
    argModeRefs: MerModeRef[]
    resultModeRef?: MerModeRef
    det?: string
}

// 函数/谓词签名信息（对应 FuncInfo / PredInfo）
export interface FuncInfo {
    name: string
    arity: number
    type: MerType           // 用 MerType 表示完整签名
    // pred: { kind: 'ho', pf: 'pred', args: MerType[] }
    // func: { kind: 'ho', pf: 'func', args: MerType[], result: MerType }
    argModes?: (string | undefined)[] // 各参数的 mode（::/>> 显式声明时收集；hover 显示用）
    resultMode?: string     // 函数返回值的 mode（= (T::out) 显式声明时收集）
    argModeRefs?: MerModeRef[]  // 结构化参数 mode（mode 分析 Phase B 用；未注解默认填充 in）
    resultModeRef?: MerModeRef  // 函数返回值结构化 mode（未注解默认 out）
    hasExplicitModes?: boolean  // 声明带 ::/>> 显式 mode 注解（Phase D：false 时可被 infer_modes 推断）
    modes?: ProcMode[]      // 全部过程 mode（多 mode：调用点任一匹配即合法；子句侧逐个检查）
}

// mode 项 → 字符串：原子（in/out/ground...）或复合（in(i_node)）；>>/2 用中缀形式
export function merModeToString(term: Term): string {
    if (term.name === '>>' && term.args.length === 2) {
        return `${merModeToString(term.args[0])} >> ${merModeToString(term.args[1])}`
    }
    if (term.args.length > 0) {
        return `${term.name}(${term.args.map(merModeToString).join(', ')})`
    }
    return term.name
}

// 参数的 mode（::/2 或 >>/2 注解的右侧）；无注解返回 undefined
export function modeOfArg(arg: Term): string | undefined {
    if ((arg.nameArity === '::/2' || arg.nameArity === '>>/2') && arg.args.length === 2) {
        return merModeToString(arg.args[1])
    }
    return undefined
}

// 参数列表的 modes；全部未注解时返回 undefined（hover 不显示 mode）
export function argModesOf(args: Term[]): (string | undefined)[] | undefined {
    const modes = args.map(modeOfArg)
    return modes.some(m => m !== undefined) ? modes : undefined
}

// 推断结果：某项的类型，以及在类型上下文可消歧时给出的类别（构造子/函数）。
export interface InferredInfo {
    type: MerType
    category?: 'constructor' | 'func' | 'pred'
}

export function keyOf(name: string, arity: number): string {
    return name + '/' + arity
}

// 把类型表达式 Term 转换为 MerType。Term 是解析出的类型 AST：
// 变量 → var；builtin/用户类型 → ctor；高阶 pred/func → ho；列表/元组 → ctor
export function termToMerType(term: Term): MerType {
    // 变量（类型变量大写）
    if (term.syntaxType === 'variable') {
        return { kind: 'var', name: term.name }
    }
    const name = term.name
    const arity = term.arity
    // 列表语法 [T] / [|]/2
    if (name === '[]' && arity === 0) {
        return { kind: 'ctor', name: 'list', args: [{ kind: 'var', name: '_' }] }
    }
    if (name === '[|]' && arity === 2) {
        const elem = termToMerType(term.args[0])
        return { kind: 'ctor', name: 'list', args: [elem] }
    }
    // 元组 {}/2（'{}'）
    if ((name === '{}' || name === "'{}'") && arity >= 2) {
        return { kind: 'ctor', name: '{}', args: term.args.map(termToMerType) }
    }
    // 剥离 Type :: Inst / Type >> Mode 的模式注解，取真实类型
    if ((name === '::' || name === '>>') && arity === 2) {
        return termToMerType(term.args[0])
    }
    // 类型表达式里的 `-`/2 恒为 pair 构造子（如 assoc_list(K,V) == list(K - V) 的 K - V）
    if (name === '-' && arity === 2) {
        return { kind: 'ctor', name: 'pair', args: term.args.map(termToMerType) }
    }
    // 高阶函数类型 func(A1,...) = R（别名 function(...)）
    if (name === '=' && arity === 2 && ['func', 'function'].includes(term.args[0]?.name)) {
        const head = term.args[0]
        return {
            kind: 'ho', pf: 'func',
            args: head.args.map(termToMerType),
            result: termToMerType(term.args[1]),
        }
    }
    if (name === 'func' || name === 'function') {
        return { kind: 'ho', pf: 'func', args: term.args.map(termToMerType) }
    }
    if (name === 'pred' || name === 'predicate') {
        return { kind: 'ho', pf: 'pred', args: term.args.map(termToMerType) }
    }
    // 普通类型构造子（含 builtin int/float/string/char 与用户类型、->/2 函数类型）
    return { kind: 'ctor', name, args: term.args.map(termToMerType) }
}

// MerType → 可读字符串（用于 hover 展示变量/项的类型）。
// 推断引擎为未受约束位置生成的内部类型变量（freshVar 的 ?0/?1/...）意味着「未推断出类型」，
// 显示为 unknown；源码里声明的类型变量（如 pair(K,V) 的 K/V、func f(T)=T 的 T）保持原名。
export function merTypeToString(t: MerType): string {
    const render = (ty: MerType): string => {
        switch (ty.kind) {
            case 'var':
                return /^\?\d+$/.test(ty.name) ? 'unknown' : ty.name
            case 'ctor':
                if (ty.args.length === 0) return ty.name
                return `${ty.name}(${ty.args.map(render).join(', ')})`
            case 'ho': {
                const args = ty.args.map(render).join(', ')
                return ty.pf === 'func'
                    ? `func(${args}) = ${ty.result ? render(ty.result) : '?'}`
                    : `pred(${args})`
            }
        }
    }
    return render(t)
}

