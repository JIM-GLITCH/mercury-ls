import { Term } from './term'
import type { MerModeRef } from './document-mode'
import { Logical } from './logical-var';

// 轻量类型表示（对应编译器 mer_type），仅用于 LSP 级消歧，不含 kind / 类型类约束
export type MerType =
    | varType
    | constructorType
    | predType
    | funcType
    | typeType;

export type varType = { kind: 'var'; name: string; bind?: MerType }
/** module?: 限定类型名（如 `dir.stream`）的模块前缀；仅作展示/导航元数据，不参与类型合一 */
export type constructorType = { kind: 'constructor'; name: string, args: MerType[]; result: MerType; module?: string }
export type predType = { kind: 'pred'; name: string, args: MerType[]; module?: string }
export type funcType = { kind: 'func'; name: string, args: MerType[]; result?: MerType; module?: string }
export type typeType = { kind: "type", name: string; args: MerType[]; module?: string }

export function varType(name: string, bind?: MerType): varType {
    return { kind: 'var', name, bind } 
}

export function constructorType(name: string, args: MerType[], result: MerType): constructorType
export function constructorType(name: string, args: Logical<MerType>[], result: Logical<MerType>): Logical<constructorType>
export function constructorType(name: string, args: MerType[] | Logical<MerType>[], result: MerType | Logical<MerType>): constructorType | Logical<constructorType> {
    return { kind: 'constructor', name, args, result }
}

export function predType(name: string, args: MerType[]): predType
export function predType(name: string, args: Logical<MerType>[]): Logical<predType>
export function predType(name: string, args: MerType[] | Logical<MerType>[]): predType | Logical<predType> {
    return { kind: 'pred', name, args }
}

export function funcType(name: string, args: MerType[], result?: MerType): funcType
export function funcType(name: string, args: Logical<MerType>[], result?: Logical<MerType>): Logical<funcType>
export function funcType(name: string, args: MerType[] | Logical<MerType>[], result?: MerType | Logical<MerType>): funcType | Logical<funcType> {
    return { kind: 'func', name, args, result }
}

export function typeType(name: string, args: MerType[]): typeType
export function typeType(name: string, args: Logical<MerType>[]): Logical<typeType>
export function typeType(name: string, args: MerType[] | Logical<MerType>[]): typeType | Logical<typeType> {
    return { kind: 'type', name, args }
}



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

// 把类型表达式 Term 转换为 MerType：变量 → varType，命名/参数化类型 → typeType，
// 高阶 pred/func 类型 → predType/funcType；全部通过构造函数生成，避免旧的 ctor/ho 表示
export function termToMerType(term: Term): MerType {
    if (term.syntaxType === 'variable') return varType(term.name)
    const name = term.name
    const arity = term.arity
    // 列表语法 [T] / [|]/2
    if (name === '[]' && arity === 0) return typeType('list', [varType('_')])
    if (name === '[|]' && arity === 2) return typeType('list', [termToMerType(term.args[0])])
    // 元组 {}/2（'{}'）
    if ((name === '{}' || name === "'{}'") && arity >= 2) {
        return typeType('{}', term.args.map(termToMerType))
    }
    // 剥离 Type :: Inst / Type >> Mode 的模式注解，取真实类型
    if ((name === '::' || name === '>>') && arity === 2) return termToMerType(term.args[0])
    // 类型表达式里的 `-`/2 恒为 pair 构造子（如 assoc_list(K,V) == list(K - V) 的 K - V）
    if (name === '-' && arity === 2) return typeType('pair', term.args.map(termToMerType))
    // 高阶函数类型 func(A1,...) = R（别名 function(...)）
    if (name === '=' && arity === 2 && ['func', 'function'].includes(term.args[0]?.name)) {
        return funcType('func', term.args[0].args.map(termToMerType), termToMerType(term.args[1]))
    }
    if (name === 'func' || name === 'function') {
        return funcType('func', term.args.map(termToMerType))
    }
    if (name === 'pred' || name === 'predicate') {
        return predType('pred', term.args.map(termToMerType))
    }
    // 普通类型构造子（含 builtin int/float/string/char 与用户类型、->/2 函数类型）
    return typeType(name, term.args.map(termToMerType))
}

// MerType → 可读字符串（用于 hover 展示变量/项的类型）。
// 推断引擎为未受约束位置生成的内部类型变量（freshVar 的 ?0/?1/...）意味着「未推断出类型」，
// 显示为 unknown；源码里声明的类型变量（如 pair(K,V) 的 K/V、func f(T)=T 的 T）保持原名。
export function merTypeToString(t: MerType): string {
    const seen = new Set<MerType>()
    const render = (ty: MerType): string => {
        // 递归类型（如 list(T) 经合一变为 list(list(...))，或 X = node(X, Y)）
        // 会在对象引用层面成环，按引用记录已访问节点，遇环输出 '...' 防止栈溢出
        if (seen.has(ty)) return '...'
        seen.add(ty)
        let s: string
        switch (ty.kind) {
            case 'var':
                s = /^\?\d+$/.test(ty.name) ? 'unknown' : ty.name
                break
            case 'type':
            case 'constructor':
                s = ty.args.length === 0 ? ty.name : `${ty.name}(${ty.args.map(render).join(', ')})`
                break
            case 'pred':
                s = `pred(${ty.args.map(render).join(', ')})`
                break
            case 'func':
                s = `func(${ty.args.map(render).join(', ')}) = ${ty.result ? render(ty.result) : '?'}`
                break
        }
        seen.delete(ty)
        return s
    }
    return render(t)
}

