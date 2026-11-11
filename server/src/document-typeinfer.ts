/******************************************************************************
 * 构建阶段 3：clause body 的类型推导 + 名称解析（qualified）
 *
 * 基于 CLP（约束逻辑编程）的完整实现：
 * 1. 遍历 AST 时收集所有类型约束
 * 2. 收集完成后统一求解所有约束  
 * 3. 处理名称可以是 func、pred、constructor 三种类型的歧义
 ******************************************************************************/
import { CancellationToken } from 'vscode-languageserver'
import type { MercuryDocument } from './document-manager'
import type { Clause, Term } from './term'
import {
    InferredInfo, MerType, varType, typeType, constructorType,
} from './document-type'
import {
    createLogicVar, resolve, useTrail,
    type LogicVar, type Logical,
} from './logical-var'
import type { GlobalIndex, SymbolEntry } from './document-index'
import { interruptAndCheck } from './promise-util'
import { moduleQualifiedName } from './utils'
import type { MercuryServices } from './services'

// 声明里的签名是纯 MerType 模板（只读）；每次使用点实例化成可合一的逻辑项
type LType = Logical<MerType>
type LVar = LogicVar<MerType>

/** 签名实例化后的形状：类型变量已换成逻辑变量，参数/返回值都可直接合一 */
interface InstantiatedSignature {
    kind: MerType['kind']
    args: LType[]
    result?: LType
}

// ==================== CLP 核心类型定义 ====================

/** 约束类型 */
type Constraint =
    | { kind: 'unify'; left: LVar; right: LType }
    | { kind: 'call'; term: Term; candidates: TypeCandidate[]; argVars: (LVar | undefined)[]; resultVar?: LVar }

/** 类型候选；entry 指向全局符号表里被选中的定义/声明，供名称解析落盘 */
interface TypeCandidate {
    signature: MerType
    kind: 'pred' | 'func' | 'constructor'
    entry?: SymbolEntry
}

/** 变量上下文 */
interface VarContext {
    varNameType: Map<string, LVar>
    constraints: Constraint[]
    termType: Map<Term, LVar>  // 项到逻辑变量的映射
}

// ==================== 辅助函数 ====================

function isVariable(term: Term) {
    return term.syntaxType === 'variable'
}

function nameArity(term: Term, nameArity: string) {
    return term.nameArity === nameArity
}

// 内建算术运算符
const BUILTIN_ARITH_OPS = new Set([
    '+', '-', '*', '/', '//', 'div', 'mod', 'rem', '**', '<<', '>>', '/\\', '\\/', 'xor',
])

const NUMERIC_CTORS = new Set([
    'int', 'float', 'uint',
    'int8', 'int16', 'int32', 'int64',
    'uint8', 'uint16', 'uint32', 'uint64',
])

/** Mercury 内建 list 构造子签名；未加载 list.m 时也能解构 [] / [H|T] */
function builtinListConstructor(name: string, arity: number): MerType | undefined {
    const elem = varType('T')
    const listT = typeType('list', [elem])
    if (name === '[]' && arity === 0) return constructorType('[]', [], listT)
    if (name === '[|]' && arity === 2) return constructorType('[|]', [elem, listT], listT)
    return undefined
}

// ==================== 完整的 CLP 类型推断器 ====================

export class TypeInferer {
    private index: GlobalIndex
    private typeVarCounter = 0
    private currentDoc?: MercuryDocument

    constructor(services: MercuryServices) {
        this.index = services.index
    }

    /**
     * 推断文档中的类型（三阶段 CLP）
     */
    async inferDocument(doc: MercuryDocument, cancelToken: CancellationToken = CancellationToken.None) {
        const inferred = new Map<Term, InferredInfo>()
        doc.inferred = inferred
        this.currentDoc = doc
        const resolved = this.prepareDocument(doc)

        for (const clause of doc.parseResult.value.args) {
            await interruptAndCheck(cancelToken)
            this.inferClause(clause, inferred, resolved)
        }
    }

    /**
     * 推导前先把「这个 term 是哪个符号」落盘到 doc.resolved：
     * 1. 本文件登记进 GlobalIndex 的声明/定义项，按 term 直接索引；
     * 2. 遍历 AST 补 term.clause，并记录 module / import 声明；
     * 之后 provider 只需 O(1) 读 doc.resolved，不必再扫 AST 或重跑候选匹配。
     */
    private prepareDocument(doc: MercuryDocument): Map<Term, SymbolEntry[]> {
        const resolved = new Map<Term, SymbolEntry[]>()
        doc.resolved = resolved
        for (const entry of this.index.byName.values()) {
            if (entry.doc === doc) resolved.set(entry.term, [entry])
        }

        const imports: Term[] = []
        doc.importModules = imports
        doc.moduleTerm = undefined
        doc.moduleName = undefined
        const references: Term[] = []
        doc.references = references

        const flatten = (term: Term | undefined) => {
            if (!term) return
            if (term.nameArity === ',/2') {
                flatten(term.args[0])
                flatten(term.args[1])
            } else {
                imports.push(term)
            }
        }
        const seen = new Set<Term>()
        const walk = (term: Term, clause: Clause) => {
            if (!term || seen.has(term)) return
            seen.add(term)
            if (term !== clause && !term.clause) term.clause = clause
            if (term.semanticType) references.push(term)
            for (const arg of term.args ?? []) walk(arg, clause)
        }
        for (const clause of doc.parseResult.value.args as Clause[]) {
            const top = clause.term
            if (top?.nameArity === ':-/1') {
                const decl = top.args[0]
                if (decl?.nameArity === 'module/1') {
                    doc.moduleTerm = decl.args[0]
                    doc.moduleName = moduleQualifiedName(doc.moduleTerm)
                } else if (decl && ['import_module/1', 'use_module/1', 'include_module/1'].includes(decl.nameArity)) {
                    flatten(decl.args[0])
                }
            }
            walk(clause, clause)
        }
        return resolved
    }

    inferClause(clause: Clause, inferred: Map<Term, InferredInfo>, resolved: Map<Term, SymbolEntry[]>) {
        // 为每个 clause 创建独立的变量上下文
        const context: VarContext = {
            varNameType: new Map(),
            constraints: [],
            termType: new Map(),
        }

        let topTerm = clause.term
        switch (topTerm.nameArity) {
            case ":-/1":
                // declaration : ':-'(Decl) - 声明不需要类型推断
                break
            case ":-/2":
                // rule : ':-'(RuleHead,RuleBody)
                this.inferRuleHead(topTerm.args[0], context)
                this.inferRuleBody(topTerm.args[1], context)
                break
            case "=/2":
                // func_fact ：'='(Func,FuncReturn)
                this.inferFuncRuleHead(topTerm, context)
                break
            case "-->/2":
                // dcg : '-->'(DcgHead,DcgBody)
                this.inferDcgHead(topTerm.args[0], context)
                this.inferDcgBody(topTerm.args[1], context)
                break
            default:
                // pred_fact : PredFact
                this.inferPredDef(topTerm, context)
                break
        }

        // 求解约束
        this.solveConstraints(context, inferred, resolved)
    }

    /** 创建新的类型变量 */
    private freshTypeVar(): LVar {
        return createLogicVar<MerType>()
    }

    /** 获取或创建 term 的类型变量 */
    private getOrCreateTypeVar(term: Term, context?: VarContext): LVar {
        if (context) {
            let varType = context.termType.get(term)
            if (!varType) {
                varType = this.freshTypeVar()
                context.termType.set(term, varType)
            }
            return varType
        }
        return this.freshTypeVar()
    }

    /** 推断规则头（谓词头） */
    private inferRuleHead(term: Term, context: VarContext) {
        if (nameArity(term, '=/2')) {
            this.inferFuncRuleHead(term, context)
        } else {
            this.inferPredDef(term, context)
        }
    }

    /** 推断谓词定义/事实 */
    private inferPredDef(term: Term, context: VarContext) {
        // 为谓词头创建类型变量
        const argVars = term.args.map(arg => this.inferTerm(arg, context))
        const headVar = this.freshTypeVar()
        context.termType.set(term, headVar)

        // 查找谓词的签名（如果有）
        const candidates = this.getTypeCandidates(term.name, term.semanticArity ?? term.arity, ['pred'])
        if (candidates.length > 0) {
            // 为每个候选生成 call 约束
            context.constraints.push({
                kind: 'call',
                term,
                candidates,
                argVars,
            })
        } else {
            // 如果没有签名，保持自由变量
        }
    }

    /**
     * 从全局索引中找到 函数名字 参数个数 匹配的项 
     * 如果找到1个 那就直接unify
     * 如果找到2个以上 那就延迟执行
     * 如果找到0个那就 报错
     * 
    */
    private inferFuncRuleHead(term: Term, context: VarContext) {
        this.getOrCreateTypeVar(term, context)
        const [func, funcResult] = term.args

        // 头部的参数/结果是数据项，按 inferTerm 走才能与 clause 内同名变量共享逻辑变量
        const argVars = func.args.map(arg => this.inferTerm(arg, context))
        const resultVar = this.inferTerm(funcResult, context)
        const funcVar = this.getOrCreateTypeVar(func, context)
        context.constraints.push({ kind: 'unify', left: funcVar, right: resultVar })

        // 无声明（只有定义、没有 :- func 声明）时保留自由类型变量，不报错
        const candidates = this.getTypeCandidates(func.name, func.semanticArity ?? func.arity, ['func'])
        context.constraints.push({
            kind: 'call',
            term: func,
            candidates,
            argVars,
            resultVar,
        })
    }

    /** 推断 DCG 头 */
    private inferDcgHead(term: Term, context: VarContext) {
        // DCG 头的语义元数 = 语法元数 + 2
        term.semanticArity = term.arity + 2
        this.inferPredDef(term, context)
    }

    /** 推断规则体 */
    private inferRuleBody(term: Term, context: VarContext) {
        switch (term.nameArity) {
            case "some/2":
            case "all/2":
                this.inferRuleBody(term.args[1], context)
                break
            case ",/2":
            case "&/2":
            case ";/2":
                this.inferRuleBody(term.args[0], context)
                this.inferRuleBody(term.args[1], context)
                break
            case "true":
            case "fail":
                break
            case "not/1":
            case "\\+/1":
                this.inferRuleBody(term.args[0], context)
                break
            case "impure/1":
            case "semipure/1":
            case "pure/1":
                this.inferRuleBody(term.args[0], context)
                break
            case "=>/2":
            case "<=/2":
            case "<=>/2":
            case "else/2":
                this.inferRuleBody(term.args[0], context)
                this.inferRuleBody(term.args[1], context)
                break
            case "if/1":
                this.inferRuleBody(term.args[0], context)
                break
            case "then/2":
                this.inferRuleBody(term.args[0], context)
                this.inferRuleBody(term.args[1], context)
                break
            case "->/2":
                this.inferRuleBody(term.args[0], context)
                this.inferRuleBody(term.args[1], context)
                break
            case "=/2":
            case "\\=/2": {
                // 等式两侧必须是同一类型；X = 1 / X = f(1) 都靠这条约束传播类型
                const left = this.inferTerm(term.args[0], context)
                const right = this.inferTerm(term.args[1], context)
                context.constraints.push({ kind: 'unify', left, right })
                break
            }
            default:
                this.inferPredRef(term, context)
        }
    }

    /** 推断 DCG 体 */
    private inferDcgBody(term: Term, context: VarContext) {
        switch (term.nameArity) {
            case "some/2":
            case "all/2":
                this.inferDcgBody(term.args[1], context)
                break
            case ",/2":
            case ";/2":
                this.inferDcgBody(term.args[0], context)
                this.inferDcgBody(term.args[1], context)
                break
            case '{}/1':
                this.inferRuleBody(term.args[0], context)
                break
            case "not/1":
            case "\\+/1":
                this.inferDcgBody(term.args[0], context)
                break
            case "impure/1":
            case "semipure/1":
            case "pure/1":
                this.inferDcgBody(term.args[0], context)
                break
            case "else/2":
                this.inferDcgBody(term.args[0], context)
                this.inferDcgBody(term.args[1], context)
                break
            case "if/1":
                this.inferDcgBody(term.args[0], context)
                break
            case "then/2":
            case "->/2":
                this.inferDcgBody(term.args[0], context)
                this.inferDcgBody(term.args[1], context)
                break
            case "=/1":
            case ":=/1":
                this.inferTerm(term.args[0], context)
                break
            case "=^/2":
                this.inferTerm(term.args[0], context)
                this.inferFieldList(term.args[1], context)
                break
            case ":=/2":
                if (nameArity(term.args[0], "^/1")) {
                    this.inferFieldList(term.args[0].args[0], context)
                } else {
                    this.inferTerm(term.args[0], context)
                }
                this.inferTerm(term.args[1], context)
                break
            case "^/1":
                this.inferRuleBody(term.args[0], context)
                break
            default:
                term.semanticArity = term.arity + 2
                this.inferPredRef(term, context)
        }
    }

    /** 推断谓词引用 */
    private inferPredRef(term: Term, context: VarContext) {
        const argVars = term.args.map(arg => this.inferTerm(arg, context))
        const headVar = this.freshTypeVar()
        context.termType.set(term, headVar)

        // 查找候选签名（pred/func/constructor 都可能）
        const candidates = this.getTypeCandidates(term.name, term.semanticArity ?? term.arity, ['pred', 'func', 'constructor'])
        if (candidates.length > 0) {
            context.constraints.push({
                kind: 'call',
                term,
                candidates,
                argVars,
            })
        }
    }

    /** 推断普通 term（数据项） */
    private inferTerm(term: Term, context: VarContext): LVar {
        if (isVariable(term)) {
            return this.inferVariable(term, context)
        }

        const existingVar = context.termType.get(term)
        if (existingVar) return existingVar

        // 根据语法类型推断
        switch (term.syntaxType) {
            case 'integer':
                // 整数类型 - 直接创建已知类型的逻辑变量
                const intVar = createLogicVar<MerType>()
                context.termType.set(term, intVar)
                context.constraints.push({
                    kind: 'unify',
                    left: intVar,
                    right: typeType('int', []) as any,
                })
                return intVar
            case 'float':
                const floatVar = createLogicVar<MerType>()
                context.termType.set(term, floatVar)
                context.constraints.push({
                    kind: 'unify',
                    left: floatVar,
                    right: typeType('float', []) as any,
                })
                return floatVar
            case 'string':
                const stringVar = createLogicVar<MerType>()
                context.termType.set(term, stringVar)
                context.constraints.push({
                    kind: 'unify',
                    left: stringVar,
                    right: typeType('string', []) as any,
                })
                return stringVar
            case 'atom': {
                // 可能是构造子/函数调用
                const atomVar = this.freshTypeVar()
                context.termType.set(term, atomVar)
                if (nameArity(term, '@/2')) {
                    // X@Term：变量、Term、整个 @ 表达式三者同类型
                    const [varPart, valuePart] = term.args.map(arg => this.inferTerm(arg, context))
                    context.constraints.push({ kind: 'unify', left: atomVar, right: varPart })
                    context.constraints.push({ kind: 'unify', left: atomVar, right: valuePart })
                } else {
                    this.inferDataFunctor(term, context)
                }
                return atomVar
            }
            default:
                // 其他类型 - 创建逻辑变量并递归处理参数
                const typeVar = this.freshTypeVar()
                context.termType.set(term, typeVar)
                for (const arg of term.args ?? []) {
                    this.inferTerm(arg, context)
                }
                return typeVar
        }
    }

    /** 推断变量 */
    private inferVariable(term: Term, context: VarContext): LVar {
        const name = term.name
        let varType = context.varNameType.get(name)

        if (!varType) {
            varType = this.freshTypeVar()
            context.varNameType.set(name, varType)
        }

        context.termType.set(term, varType)
        return varType
    }

    /** 推断数据 functor（构造子/函数） */
    private inferDataFunctor(term: Term, context: VarContext) {
        const argVars = term.args.map(arg => this.inferTerm(arg, context))
        const typeVar = context.termType.get(term)!

        // 查找候选签名
        const candidates = this.getTypeCandidates(term.name, term.arity, ['constructor', 'func'])
        if (candidates.length > 0) {
            context.constraints.push({
                kind: 'call',
                term,
                candidates,
                argVars,
            })
        }
    }

    /** 推断字段列表 */
    private inferFieldList(term: Term, context: VarContext) {
        if (!term) return
        if (term.nameArity === '^/2' || term.nameArity === '^/1') {
            for (const arg of term.args) {
                this.inferFieldList(arg, context)
            }
            return
        }
        this.inferTerm(term, context)
    }

    /** 从 GlobalIndex 获取类型候选 */
    private getTypeCandidates(name: string, arity: number, kinds: TypeCandidate['kind'][]): TypeCandidate[] {
        const candidates: TypeCandidate[] = []
        for (const symbol of this.index.get(name)) {
            if (kinds.includes(symbol.kind as TypeCandidate['kind']) && symbol.arity === arity && symbol.signature) {
                candidates.push({
                    signature: symbol.signature,
                    kind: symbol.kind as TypeCandidate['kind'],
                    entry: symbol,
                })
            }
        }
        // 索引里有 list.m 时用真实定义，否则退回内建 list 构造子
        if (candidates.length === 0 && kinds.includes('constructor')) {
            const signature = builtinListConstructor(name, arity)
            if (signature) candidates.push({ signature, kind: 'constructor' })
        }
        return candidates
    }

    /** 求解约束：所有绑定共用一条 trail，候选失败时才能正确回滚 */
    private solveConstraints(
        context: VarContext,
        inferred: Map<Term, InferredInfo>,
        resolved: Map<Term, SymbolEntry[]>
    ) {
        const solver = useTrail()
        const categories = new Map<Term, TypeCandidate['kind']>()

        for (const constraint of context.constraints) {
            if (constraint.kind === 'unify') {
                solver.unify(constraint.left, constraint.right)
                continue
            }
            for (const candidate of constraint.candidates) {
                const mark = solver.mark()
                if (this.tryUnifyCall(constraint, candidate, solver.unify, context)) {
                    categories.set(constraint.term, candidate.kind)
                    // 引用项 → 选中的全局符号；本文件已登记的声明/定义项保持指向自己
                    if (candidate.entry && !resolved.has(constraint.term)) {
                        resolved.set(constraint.term, [candidate.entry])
                    }
                    break
                }
                solver.undo(mark)
            }
        }

        // 写入合一后的实际类型，而不是带 T 的声明模板
        for (const [term, typeVar] of context.termType) {
            inferred.set(term, {
                type: resolve(typeVar, () => varType('?0')) as MerType,
                category: categories.get(term),
            })
        }
    }

    /** 尝试将调用与候选签名合一 */
    private tryUnifyCall(
        constraint: Extract<Constraint, { kind: 'call' }>,
        candidate: TypeCandidate,
        unify: (x: unknown, y: unknown) => boolean,
        context: VarContext
    ): boolean {
        const { signature, kind } = candidate
        const { argVars, resultVar } = constraint
        const termVar = context.termType.get(constraint.term)
        const inst = this.makeLogical(signature)

        if (kind === 'pred' && signature.kind === 'pred') {
            // 谓词：只合一参数类型
            if (inst.args.length !== argVars.length) return false
            for (let i = 0; i < argVars.length; i++) {
                if (!unify(argVars[i], inst.args[i])) return false
            }
            return true
        } else if (kind === 'func' && signature.kind === 'func') {
            // 函数：合一参数类型；func rule 的结果项与返回类型合一。
            // 数据位置的调用项类型留给外层上下文（如 pred 形参）决定，避免声明模板
            // 里未实例化/写法歧义的返回类型覆盖掉上下文已经推出的类型。
            if (inst.args.length !== argVars.length) return false
            for (let i = 0; i < argVars.length; i++) {
                if (!unify(argVars[i], inst.args[i])) return false
            }
            if (resultVar && inst.result && !unify(resultVar, inst.result)) return false
            return true
        } else if (kind === 'constructor' && signature.kind === 'constructor') {
            // 构造子：合一参数类型，结果类型与项的类型变量合一
            if (inst.args.length !== argVars.length) return false
            for (let i = 0; i < argVars.length; i++) {
                if (!unify(argVars[i], inst.args[i])) return false
            }
            if (termVar && inst.result && !unify(termVar, inst.result)) return false
            return true
        }

        return false
    }

    /** 签名模板 → 逻辑项：同一签名里同名的类型变量共享一个逻辑变量 */
    private makeLogical(type: MerType): InstantiatedSignature {
        const vars = new Map<string, LVar>()
        const convert = (x: unknown): unknown => {
            if (Array.isArray(x)) return x.map(convert)
            if (x && typeof x === 'object') {
                const node = x as Record<string, unknown>
                if (node.kind === 'var') {
                    const name = node.name as string
                    let v = vars.get(name)
                    if (!v) {
                        v = this.freshTypeVar()
                        vars.set(name, v)
                    }
                    return v
                }
                const out: Record<string, unknown> = {}
                for (const [key, value] of Object.entries(node)) {
                    out[key] = convert(value)
                }
                return out
            }
            return x
        }
        return convert(type) as InstantiatedSignature
    }
}
