// ===== 结构化 inst / mode 表示（mode 分析 Phase A）=====
// 对应编译器 prog_data.m 的 mer_inst / from_to_mode 的裁剪版：
// - uniqueness 暂不建模（Phase E），ground/bound/any 不带 uniqueness 字段；
// - 用户 inst 只存引用不内联展开，递归 inst（如 list_skel）的匹配在 Phase B 带记忆化处理；
// - builtin 参数化模式 in(I)/out(I) 的 inst 参数 v1 丢弃（只影响 bound 分解，
//   不影响 free/ground 区分）；:- mode p(...) is det 形式的 pred-mode 暂不收集。
import { Term } from './term'

export type MerInst =
    | { kind: 'free' }
    | { kind: 'ground' }
    | { kind: 'any' }
    | { kind: 'bound'; functors: BoundFunctor[] }
    | { kind: 'user'; name: string; arity: number; args: MerInst[] }
    | { kind: 'inst_var'; name: string }
    | { kind: 'not_reached' }

export interface BoundFunctor { ctor: string; arity: number; args: MerInst[] }

export type BuiltinModeName = 'in' | 'out' | 'di' | 'uo' | 'ui' | 'muo'
export const builtinModeNames: ReadonlySet<string> = new Set(['in', 'out', 'di', 'uo', 'ui', 'muo'])

// 声明参数里的 mode 引用（`::in` / `in(node)` / `>> my_mode`）
export type MerModeRef =
    | { kind: 'builtin'; name: BuiltinModeName; args: MerInst[] }
    | { kind: 'user'; name: string; arity: number; args: MerInst[] }

// :- mode m(P1,..) == Init >> Final
// 或 mode 别名 `m(P1,..) == Body`（Body 是单个 mode 引用，如 array_uo == out(uniq_array)）：
// alias 记引用，modeRefToInsts 惰性解引用（别名可能指向尚未收集/别的用户 mode）
export interface ModeDef {
    params: string[]
    initial: MerInst
    final: MerInst
    alias?: MerModeRef
}
// :- inst i(P1,..) ---> f(..) ; g(..)  /  :- inst i == Expr
export interface InstDef { params: string[]; body: MerInst }

function isVariable(term: Term) {
    return term.syntaxType === 'variable'
}

function defKey(name: string, arity: number): string {
    return name + '/' + arity
}

// inst 表达式 Term → MerInst（变量 → inst_var，即参数化 inst 的形参引用）
export function instTermToMerInst(term: Term): MerInst {
    if (isVariable(term)) return { kind: 'inst_var', name: term.name }
    switch (term.name) {
        case 'free':
            return { kind: 'free' }
        case 'ground':
        case 'any':
        case 'not_reached':
            return { kind: term.name }
        case 'bound':
            return { kind: 'bound', functors: term.args.flatMap(instFunctorAlts) }
        // unique 系包装：v1 忽略唯一性，取内层 inst
        case 'unique':
        case 'mostly_unique':
        case 'clobbered':
        case 'mostly_clobbered':
        case 'shared':
            return term.args.length > 0 ? instTermToMerInst(term.args[0]) : { kind: 'ground' }
        default:
            return { kind: 'user', name: term.name, arity: term.arity, args: term.args.map(instTermToMerInst) }
    }
}

// `--->` 体 / bound 参数（;/2 链或单个 functor）→ 构造子列表
export function instFunctorAlts(term: Term): BoundFunctor[] {
    const out: BoundFunctor[] = []
    for (const alt of semicolonList(term)) {
        if (!isVariable(alt)) {
            out.push({ ctor: alt.name, arity: alt.arity, args: alt.args.map(instTermToMerInst) })
        }
    }
    return out
}

function semicolonList(term: Term): Term[] {
    const out: Term[] = []
    for (;;) {
        if (!isVariable(term) && term.nameArity === ';/2') {
            out.push(...semicolonList(term.args[0]))
            term = term.args[1]
        } else {
            out.push(term)
            return out
        }
    }
}

// 声明参数右侧 mode Term → MerModeRef
export function modeTermToRef(term: Term): MerModeRef {
    if (!isVariable(term) && builtinModeNames.has(term.name)) {
        return { kind: 'builtin', name: term.name as BuiltinModeName, args: term.args.map(instTermToMerInst) }
    }
    return { kind: 'user', name: term.name, arity: term.arity, args: term.args.map(instTermToMerInst) }
}

// builtin mode → (initial, final)。v1 丢弃 inst 参数（in(I) ≈ in）
const builtinModeInsts: Record<BuiltinModeName, { initial: MerInst; final: MerInst }> = {
    in: { initial: { kind: 'ground' }, final: { kind: 'ground' } },
    out: { initial: { kind: 'free' }, final: { kind: 'ground' } },
    di: { initial: { kind: 'ground' }, final: { kind: 'ground' } },
    uo: { initial: { kind: 'free' }, final: { kind: 'ground' } },
    ui: { initial: { kind: 'ground' }, final: { kind: 'ground' } },
    muo: { initial: { kind: 'free' }, final: { kind: 'ground' } },
}

// mode 引用 → (initial, final)：builtin 查表；用户 mode 查 modeDefs 并替换形参
//（mode 别名逐级解引用，防环上限 8 层；无法解析返回 undefined 由调用方宽松跳过）
export function modeRefToInsts(
    ref: MerModeRef,
    modeDefs: Map<string, ModeDef>,
): { initial: MerInst; final: MerInst } | undefined {
    if (ref.kind === 'builtin') return builtinModeInsts[ref.name]
    return resolveModeDef(defKey(ref.name, ref.arity), ref.args, modeDefs, 0)
}

// 解析用户 mode 定义：aliasInstsOf 取原始 (initial, final)（可能仍含该 def 形参的 inst_var），
// 再把引用处实参替换进形参
function resolveModeDef(
    key: string,
    args: MerInst[],
    modeDefs: Map<string, ModeDef>,
    depth: number,
): { initial: MerInst; final: MerInst } | undefined {
    if (depth > 8) return undefined
    const def = modeDefs.get(key)
    if (!def) return undefined
    const raw = aliasInstsOf(def, modeDefs, depth)
    if (!raw) return undefined
    return {
        initial: substituteInstVars(raw.initial, def.params, args),
        final: substituteInstVars(raw.final, def.params, args),
    }
}

// mode 定义体 → 原始 (initial, final)：非别名直接取；别名按指向展开——
// builtin 引用按 out(I)=free>>I、in/ui(I)=I>>I、di(I)=I>>dead(≈ground) 规则；
// user 引用递归解引用目标定义（形参替换由 resolveModeDef 完成）
function aliasInstsOf(
    def: ModeDef,
    modeDefs: Map<string, ModeDef>,
    depth: number,
): { initial: MerInst; final: MerInst } | undefined {
    if (!def.alias) return { initial: def.initial, final: def.final }
    if (depth > 8) return undefined
    const a = def.alias
    if (a.kind === 'builtin') {
        const base = builtinModeInsts[a.name]
        const sub = a.args[0]
        switch (a.name) {
            case 'out': case 'uo': case 'muo':
                return { initial: base.initial, final: sub ?? base.final }
            case 'in': case 'ui':
                return { initial: sub ?? base.initial, final: sub ?? base.final }
            default: // di
                return { initial: sub ?? base.initial, final: base.final }
        }
    }
    return resolveModeDef(defKey(a.name, a.arity), a.args, modeDefs, depth + 1)
}

// 把 inst 定义体里的 inst_var 形参替换为引用处的实参
export function substituteInstVars(inst: MerInst, params: string[], args: MerInst[]): MerInst {
    switch (inst.kind) {
        case 'inst_var': {
            const i = params.indexOf(inst.name)
            return i >= 0 && i < args.length ? args[i] : inst
        }
        case 'bound':
            return {
                kind: 'bound',
                functors: inst.functors.map(f => ({ ...f, args: f.args.map(a => substituteInstVars(a, params, args)) })),
            }
        case 'user':
            return { ...inst, args: inst.args.map(a => substituteInstVars(a, params, args)) }
        default:
            return inst
    }
}

// inst/mode 定义左端：I / I(P1,..) / I for Type/Arity → { name, arity, params }
export function instDefHead(term: Term): { name: string; arity: number; params: string[] } | undefined {
    let head = term
    if (!isVariable(head) && head.nameArity === 'for/2') head = head.args[0]
    if (isVariable(head)) return undefined
    return {
        name: head.name,
        arity: head.arity,
        params: head.args.filter(isVariable).map(v => v.name),
    }
}

export function instToString(inst: MerInst): string {
    switch (inst.kind) {
        case 'free':
        case 'ground':
        case 'any':
        case 'not_reached':
        case 'inst_var':
            return inst.kind === 'inst_var' ? inst.name : inst.kind
        case 'user':
            return inst.args.length ? `${inst.name}(${inst.args.map(instToString).join(', ')})` : inst.name
        case 'bound':
            return `bound(${inst.functors.map(f =>
                f.args.length ? `${f.ctor}(${f.args.map(instToString).join(', ')})` : f.ctor
            ).join(' ; ')})`
    }
}
