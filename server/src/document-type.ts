import { Term } from './term'
import type { MerModeRef } from './document-mode'

// 类型构造子（对应编译器 type_ctor(sym_name, arity)）
export type TypeCtor = { name: string; arity: number }

// 轻量类型表示（对应编译器 mer_type），仅用于 LSP 级消歧，不含 kind / 类型类约束
export type MerType =
    | { kind: 'var'; name: string }                              // 类型变量 T / K
    | { kind: 'ctor'; ctor: TypeCtor; args: MerType[] }          // 含 builtin（int/float/...）与用户类型
    | { kind: 'ho'; pf: 'pred' | 'func'; args: MerType[]; result?: MerType } // 高阶类型

// 数据构造子信息（对应编译器 cons_type_info）
export interface ConsInfo {
    ctor: string            // 构造子名
    arity: number
    argTypes: MerType[]     // 参数类型（与构造子参数顺序一致；存在量词变量为 var）
    resultType: MerType     // 所属类型把类型参数应用后的结果类型
    typeCtor: TypeCtor      // 所属类型
}

// 类型定义信息（对应编译器 type_ctor 的 hlds_type_defn）
export interface TypeInfo {
    ctor: TypeCtor
    params: MerType[]       // 类型参数（type 变量）
    constructors: ConsInfo[]
    body?: MerType          // 等价类型（type T == U）的底层类型；供推断展开同义词（如 assoc_list == list(pair(K,V))）
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
    argTypes: MerType[]
    argModes?: (string | undefined)[] // 各参数的 mode（::/>> 显式声明时收集；hover 显示用）
    resultType?: MerType    // func 有返回类型；pred 无
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

// 推断结果：某项的类型，以及在类型上下文可消歧时给出的类别（构造子/函数）；
// mode 为变量的子句级模式近似（head 形参的声明 mode / 局部绑定变量 out / 调用 in 实参）
export interface InferredInfo {
    type: MerType
    category?: 'constructor' | 'func'
    mode?: string           // 变量出现点的 inst 字符串（Phase C 逐出现点记录，hover 标 inst；
                            //  无记录时为子句级近似 in/out，hover 标 mode）
}

export function keyOfTypeCtor(tc: TypeCtor): string {
    return tc.name + '/' + tc.arity
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
        return { kind: 'ctor', ctor: { name: 'list', arity: 1 }, args: [{ kind: 'var', name: '_' }] }
    }
    if (name === '[|]' && arity === 2) {
        const elem = termToMerType(term.args[0])
        return { kind: 'ctor', ctor: { name: 'list', arity: 1 }, args: [elem] }
    }
    // 元组 {}/2（'{}'）
    if ((name === '{}' || name === "'{}'") && arity >= 2) {
        return { kind: 'ctor', ctor: { name: '{}', arity: arity }, args: term.args.map(termToMerType) }
    }
    // 剥离 Type :: Inst / Type >> Mode 的模式注解，取真实类型
    if ((name === '::' || name === '>>') && arity === 2) {
        return termToMerType(term.args[0])
    }
    // 类型表达式里的 `-`/2 恒为 pair 构造子（如 assoc_list(K,V) == list(K - V) 的 K - V）
    if (name === '-' && arity === 2) {
        return { kind: 'ctor', ctor: { name: 'pair', arity: 2 }, args: term.args.map(termToMerType) }
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
    return { kind: 'ctor', ctor: { name, arity }, args: term.args.map(termToMerType) }
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
                if (ty.args.length === 0) return ty.ctor.name
                return `${ty.ctor.name}(${ty.args.map(render).join(', ')})`
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

// ---- 合一（unification）----
// 极简 HM 合一：var/ctor/ho 递归合一，带 occurs check，用 subst 记录变量绑定。
// 不做 kind 检查与类型类约束（MVP）。

function occurs(name: string, t: MerType): boolean {
    switch (t.kind) {
        case 'var': return t.name === name
        case 'ctor': return t.args.some(a => occurs(name, a))
        case 'ho': return t.args.some(a => occurs(name, a)) || (t.result ? occurs(name, t.result) : false)
    }
}

export function applySubst(t: MerType, subst: Map<string, MerType>): MerType {
    if (t.kind === 'var') {
        const s = subst.get(t.name)
        // 防自指环：类型参数与同义体变量同名（如 assoc_list(K,V) 的 body 里仍是 K/V）会导致 K→K 死循环
        if (s && !(s.kind === 'var' && s.name === t.name)) return applySubst(s, subst)
        return t
    }
    if (t.kind === 'ctor') {
        return { kind: 'ctor', ctor: t.ctor, args: t.args.map(a => applySubst(a, subst)) }
    }
    return {
        kind: 'ho', pf: t.pf,
        args: t.args.map(a => applySubst(a, subst)),
        result: t.result ? applySubst(t.result, subst) : undefined,
    }
}

// 合一 a、b（就地修改 subst），成功返回 true；occurs check 失败或构造子不匹配返回 false
export function unify(a: MerType, b: MerType, subst: Map<string, MerType>): boolean {
    const a2 = applySubst(a, subst)
    const b2 = applySubst(b, subst)
    if (a2.kind === 'var' && b2.kind === 'var') {
        if (a2.name === b2.name) return true
        // 声明里的类型变量（T/A/B）与推断产生的 fresh 变量（?N）相遇时，
        // 一律把 fresh 绑定到具名变量，而不是反过来：否则具名变量会被
        // 覆盖成 ?N，hover 上整片签名都退化成 unknown。
        const fresh = (name: string) => /^\?\d+$/.test(name)
        if (!fresh(a2.name) && fresh(b2.name)) subst.set(b2.name, a2)
        else subst.set(a2.name, b2)
        return true
    }
    if (a2.kind === 'var') {
        if (occurs(a2.name, b2)) return false
        subst.set(a2.name, b2)
        return true
    }
    if (b2.kind === 'var') {
        if (occurs(b2.name, a2)) return false
        subst.set(b2.name, a2)
        return true
    }
    if (a2.kind === 'ho' && b2.kind === 'ho') {
        if (a2.pf !== b2.pf || a2.args.length !== b2.args.length) return false
        for (let i = 0; i < a2.args.length; i++) {
            if (!unify(a2.args[i], b2.args[i], subst)) return false
        }
        if (a2.result && b2.result) return unify(a2.result, b2.result, subst)
        return true
    }
    if (a2.kind === 'ctor' && b2.kind === 'ctor') {
        if (a2.ctor.name !== b2.ctor.name || a2.ctor.arity !== b2.ctor.arity) return false
        for (let i = 0; i < a2.args.length; i++) {
            if (!unify(a2.args[i], b2.args[i], subst)) return false
        }
        return true
    }
    return false
}
