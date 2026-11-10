/******************************************************************************
 * 构建阶段 3：clause body 的类型推导 + 名称解析（qualified）
 *
 * 基于 CLP（约束逻辑编程）的完整实现：
 * 1. 遍历 AST 时收集所有类型约束
 * 2. 收集完成后统一求解所有约束  
 * 3. 处理名称可以是 func、pred、constructor 三种类型的歧义
 ******************************************************************************/
import type { CancellationToken } from 'vscode-languageserver'
import type { MercuryDocument } from './document-manager'
import type { SymbolEntry } from './document-index'
import type { Clause, Term } from './term'
import {
    FuncInfo, InferredInfo, MerType, varType, predType, funcType, typeType
} from './document-type'
import {
    createLogicVar, resolve, useTrail,
    type LogicVar, type Logical,
} from './logical-var'
import type { GlobalIndex } from './document-index'
import { interruptAndCheck } from './promise-util'
import type { MercuryServices } from './services'

// 声明里的签名是纯 MerType 模板（只读）；每次使用点实例化成可合一的逻辑项
type LType = Logical<MerType>
type LVar = LogicVar<MerType>

// ==================== CLP 核心类型定义 ====================

/** 约束类型 */
type Constraint = 
    | { kind: 'unify'; left: LVar; right: LVar }
    | { kind: 'call'; term: Term; candidates: TypeCandidate[]; argVars: (LVar | undefined)[]; resultVar?: LVar }

/** 类型候选 */
interface TypeCandidate {
    signature: MerType
    kind: 'pred' | 'func' | 'constructor'
}

/** 变量上下文 */
interface VarContext {
    vars: Map<string, LVar>
    constraints: Constraint[]
    termVars: Map<Term, LVar>  // 项到逻辑变量的映射
}

// ==================== 辅助函数 ====================

function isVariable(term: Term) {
    return term.syntaxType === 'variable'
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

// ==================== 完整的 CLP 类型推断器 ====================

export class TypeInferer {
    private index: GlobalIndex
    private typeVarCounter = 0
    
    constructor(services: MercuryServices) {
        this.index = services.index
    }

    /**
     * 推断文档中的类型（三阶段 CLP）
     */
    async inferDocument(doc: MercuryDocument, cancelToken?: CancellationToken) {
        const inferred = new Map<Term, InferredInfo>()
        doc.inferred = inferred

        // 阶段 1：约束收集
        const constraints: Constraint[] = []
        const varMap = new Map<string, LVar>() // 变量名 -> 逻辑变量

        for (const clause of doc.parseResult.value.args) {
            if (cancelToken) await interruptAndCheck(cancelToken)
            this.collectClauseConstraints(clause as Clause, constraints, varMap)
        }

        // 保存约束以便后续提取类别信息
        (doc as ExtendedMercuryDocument).constraints = constraints

        // 阶段 2：约束求解
        const solved = this.solveConstraints(constraints)

        // 阶段 3：结果提取
        if (solved) {
            this.extractResults(doc, varMap, inferred)
        } else {
            this.setUnknownTypes(doc, inferred)
        }
    }
    
    // ==================== 阶段 1：约束收集 ====================
    
    /**
     * 收集子句约束
     */
    private collectClauseConstraints(
        clause: Clause,
        constraints: Constraint[],
        varMap: Map<string, LVar>
    ) {
        const ctx: VarContext = {
            vars: new Map(),
            constraints: constraints,
            termVars: new Map()
        }

        // 初始化变量逻辑变量
        for (const [varName, varTerms] of clause.varMap.entriesGroupedByKey()) {
            if (!ctx.vars.has(varName)) {
                const lv = createLogicVar<MerType>()
                ctx.vars.set(varName, lv)
                // 为每个变量项也建立映射
                for (const term of varTerms) {
                    ctx.termVars.set(term, lv)
                }
            }
        }

        // 收集子句头部的约束（包含嵌套项的类型约束）
        this.collectTermConstraints(clause.term, ctx)

        // 合并到全局变量映射（只合并变量，不合并项）
        for (const [name, lv] of ctx.vars) {
            if (!varMap.has(name)) {
                varMap.set(name, lv)
            }
        }

        // 将项的映射存储在 clause 中，供结果提取使用
        (clause as ExtendedClause).termVars = ctx.termVars
    }
    
    /**
     * 收集 term 约束
     */
    private collectTermConstraints(term: Term, ctx: VarContext) {
        switch (term.nameArity) {
            case '=/2': // 函数定义或统一
                if (this.isFunctionDefinition(term)) {
                    this.collectFunctionDefinitionConstraints(term, ctx)
                } else {
                    this.collectUnifyConstraints(term.args[0], term.args[1], ctx)
                }
                break

            case ':-/2': // 规则
                this.collectTermConstraints(term.args[0], ctx) // head
                this.collectTermConstraints(term.args[1], ctx) // body
                break

            case './2': // 限定名
                this.collectTermConstraints(term.args[1], ctx)
                break

            case ',/2': // 合取
            case ';/2': // 析取
                this.collectTermConstraints(term.args[0], ctx)
                this.collectTermConstraints(term.args[1], ctx)
                break

            case '@/2': // 项注解 Term @ Ann
                // 为注解项创建逻辑变量并添加约束
                this.collectTermAnnotationConstraints(term, ctx)
                break

            case '[|]/2': // 列表构造子 [Head | Tail]
                this.collectListConstructorConstraints(term, ctx)
                break

            case '[]/0': // 空列表
                this.collectEmptyListConstraints(term, ctx)
                break

            default:
                // 函数/谓词调用
                this.collectCallConstraints(term, ctx)
        }
    }
    
    /**
     * 收集统一约束
     */
    private collectUnifyConstraints(lhs: Term, rhs: Term, ctx: VarContext) {
        const lhsVar = this.getOrCreateTermVariable(lhs, ctx)
        const rhsVar = this.getOrCreateTermVariable(rhs, ctx)

        if (lhsVar && rhsVar) {
            ctx.constraints.push({
                kind: 'unify',
                left: lhsVar,
                right: rhsVar
            })
        }

        // 递归处理子项
        this.collectTermConstraints(lhs, ctx)
        this.collectTermConstraints(rhs, ctx)
    }
    
    /**
     * 收集调用约束
     */
    private collectCallConstraints(call: Term, ctx: VarContext) {
        // 检查是否是函数定义 f(X) = Y
        if (this.isFunctionDefinition(call)) {
            this.collectFunctionDefinitionConstraints(call, ctx)
        } else {
            // 普通调用
            const argVars = call.args.map(arg => this.getOrCreateTermVariable(arg, ctx))
            const candidates = this.getTypeCandidates(call.name, call.semanticArity)

            if (candidates.length > 0) {
                ctx.constraints.push({
                    kind: 'call',
                    term: call,
                    candidates: candidates,
                    argVars: argVars
                })
            }

            // 递归处理参数以收集嵌套项的约束
            for (const arg of call.args) {
                this.collectTermConstraints(arg, ctx)
            }
        }
    }
    
    /**
     * 判断是否是函数定义
     */
    private isFunctionDefinition(term: Term): boolean {
        return term.nameArity === '=/2' && 
               term.args[0]?.syntaxType === 'atom' &&
               term.args[0]?.nameArity !== './2' // 不是限定名
    }
    
    /**
     * 收集函数定义约束
     */
    private collectFunctionDefinitionConstraints(funcDef: Term, ctx: VarContext) {
        const funcHead = funcDef.args[0]
        const result = funcDef.args[1]

        // 获取函数参数变量
        const argVars = funcHead.args.map(arg => this.getOrCreateTermVariable(arg, ctx))
        const resultVar = this.getOrCreateTermVariable(result, ctx)

        // 获取类型候选
        const candidates = this.getTypeCandidates(funcHead.name, funcHead.semanticArity)

        if (candidates.length > 0) {
            // 添加函数调用约束（包含结果变量）
            ctx.constraints.push({
                kind: 'call',
                term: funcHead,
                candidates: candidates,
                argVars: argVars,
                resultVar: resultVar
            })
        }

        // 递归处理子项
        for (const arg of funcHead.args) {
            this.collectTermConstraints(arg, ctx)
        }
        this.collectTermConstraints(result, ctx)
    }
    
    /**
     * 获取类型候选
     */
    private getTypeCandidates(name: string, arity: number): TypeCandidate[] {
        const entries: readonly SymbolEntry[] = this.index.getByName(name)
        const candidates: TypeCandidate[] = []

        for (const s of entries) {
            if (s.arity === arity && s.signature) {
                let kind: 'pred' | 'func' | 'constructor'
                if (s.kind === 'pred') kind = 'pred'
                else if (s.kind === 'func') kind = 'func'
                else kind = 'constructor'

                candidates.push({
                    signature: s.signature,
                    kind
                })
            }
        }

        // 内置运算符
        if (BUILTIN_ARITH_OPS.has(name) && arity === 2) {
            candidates.push({
                signature: funcType(name, [varType('T'), varType('T')], varType('T')),
                kind: 'func'
            })
        }

        // 数字构造子
        if (NUMERIC_CTORS.has(name) && arity === 0) {
            candidates.push({
                signature: typeType(name, []),
                kind: 'constructor'
            })
        }

        return candidates
    }

    /**
     * 收集项注解约束 (Term @ Ann)
     */
    private collectTermAnnotationConstraints(term: Term, ctx: VarContext) {
        const lhs = term.args[0]  // 被注解的项
        const rhs = term.args[1]  // 注解（通常是变量）

        // 为整个注解项创建逻辑变量
        const termVar = this.getOrCreateTermVariable(term, ctx)

        // 为 LHS 和 RHS 创建或获取逻辑变量
        const lhsVar = this.getOrCreateTermVariable(lhs, ctx)
        const rhsVar = this.getOrCreateTermVariable(rhs, ctx)

        // 添加约束：整个注解项的类型与 LHS 相同
        if (termVar && lhsVar) {
            ctx.constraints.push({
                kind: 'unify',
                left: termVar,
                right: lhsVar
            })
        }

        // 如果 RHS 是变量，将其类型统一到注解项的类型
        if (rhsVar && termVar) {
            ctx.constraints.push({
                kind: 'unify',
                left: rhsVar,
                right: termVar
            })
        }

        // 递归处理子项
        this.collectTermConstraints(lhs, ctx)
        this.collectTermConstraints(rhs, ctx)
    }

    /**
     * 收集列表构造子约束 [|]/2
     */
    private collectListConstructorConstraints(term: Term, ctx: VarContext) {
        const head = term.args[0]  // 列表头
        const tail = term.args[1]  // 列表尾

        // 为整个列表项创建逻辑变量
        const termVar = this.getOrCreateTermVariable(term, ctx)

        // 为 head 和 tail 创建或获取逻辑变量
        const headVar = this.getOrCreateTermVariable(head, ctx)
        const tailVar = this.getOrCreateTermVariable(tail, ctx)

        // 添加约束：head 和 tail 应该与 term 具有相同的类型（list(T)）
        // 当 term 被统一为 list(int) 时，head 和 tail 也会被统一
        if (termVar && headVar) {
            ctx.constraints.push({
                kind: 'unify',
                left: termVar,
                right: headVar
            })
        }

        if (termVar && tailVar) {
            ctx.constraints.push({
                kind: 'unify',
                left: termVar,
                right: tailVar
            })
        }

        // 递归处理子项
        this.collectTermConstraints(head, ctx)
        this.collectTermConstraints(tail, ctx)
    }

    /**
     * 收集空列表约束 []/0
     */
    private collectEmptyListConstraints(term: Term, ctx: VarContext) {
        const termVar = this.getOrCreateTermVariable(term, ctx)
        if (termVar) {
            // 空列表的类型是 list(T)，其中 T 是类型变量
            const elemType = createLogicVar<MerType>()
            const listType = typeType('list', [elemType])
            ctx.constraints.push({
                kind: 'unify',
                left: termVar,
                right: elemType
            })
        }
    }

    /**
     * 获取或创建项的逻辑变量
     */
    private getOrCreateTermVariable(term: Term, ctx: VarContext): LVar | undefined {
        // 如果是变量，返回变量对应的逻辑变量
        if (term.syntaxType === 'variable') {
            if (!ctx.vars.has(term.name)) {
                const lv = createLogicVar<MerType>()
                ctx.vars.set(term.name, lv)
            }
            return ctx.vars.get(term.name)
        }

        // 如果是非变量项，创建或获取该项的逻辑变量
        if (!ctx.termVars.has(term)) {
            const lv = createLogicVar<MerType>()
            ctx.termVars.set(term, lv)
        }
        return ctx.termVars.get(term)
    }
    
    // ==================== 阶段 2：约束求解 ====================
    
    /**
     * 求解约束
     */
    private solveConstraints(constraints: Constraint[]): boolean {
        const trail = useTrail()
        
        // 先应用简单的统一约束
        for (const constraint of constraints) {
            if (constraint.kind === 'unify') {
                if (!trail.unify(constraint.left, constraint.right)) {
                    return false
                }
            }
        }
        
        // 最后应用调用约束（可能有多个候选）
        for (const constraint of constraints) {
            if (constraint.kind === 'call') {
                if (!this.applyCallConstraint(constraint, trail)) {
                    return false
                }
            }
        }
        
        return true
    }
    
    /**
     * 应用调用约束
     */
    private applyCallConstraint(constraint: CallConstraint, trail: ReturnType<typeof useTrail>): boolean {
        // 如果没有候选，跳过
        if (constraint.candidates.length === 0) {
            return true
        }

        // 优先级排序：constructor > func > pred
        // 这样在有歧义时，优先选择更具体的候选
        const priorityOrder: ('constructor' | 'func' | 'pred')[] = ['constructor', 'func', 'pred']
        const sortedCandidates = [...constraint.candidates].sort((a, b) => {
            const aPriority = priorityOrder.indexOf(a.kind)
            const bPriority = priorityOrder.indexOf(b.kind)
            return aPriority - bPriority
        })

        // 尝试所有候选（CLP choice point）
        for (const candidate of sortedCandidates) {
            const mark = trail.mark()
            if (this.tryCandidate(constraint, candidate, trail)) {
                return true
            }
            trail.undo(mark)
        }

        return false
    }
    
    /**
     * 尝试类型候选
     */
    private tryCandidate(
        constraint: CallConstraint,
        candidate: TypeCandidate,
        trail: ReturnType<typeof useTrail>
    ): boolean {
        // 实例化签名
        const typeVars = new Map<string, LVar>()
        const instantiated = this.instantiateSignature(candidate.signature, typeVars)

        // 获取参数类型
        const argTypes = candidate.signature.kind === 'pred' || candidate.signature.kind === 'func'
            ? (candidate.signature as predType | funcType).args || []
            : candidate.signature.kind === 'constructor'
            ? (candidate.signature as constructorType).args || []
            : []

        // 统一参数类型
        for (let i = 0; i < constraint.argVars.length; i++) {
            const argVar = constraint.argVars[i]
            const argType = argTypes[i]

            if (argVar && argType) {
                if (!trail.unify(argVar, instantiated.args[i])) {
                    return false
                }
            }
        }

        // 如果是函数且有结果变量，统一结果类型
        if (constraint.resultVar && instantiated.result) {
            if (!trail.unify(constraint.resultVar, instantiated.result)) {
                return false
            }
        }

        // 记录选中的候选类别（用于后续结果提取）
        constraint.selectedCategory = candidate.kind

        return true
    }
    
    /**
     * 实例化签名
     */
    private instantiateSignature(sig: MerType, typeVars: Map<string, LVar>): { args: LType[], result?: LType } {
        const instantiate = (type: MerType): LType => {
            if (type.kind === 'var') {
                let v = typeVars.get(type.name)
                if (!v) {
                    v = createLogicVar<MerType>()
                    typeVars.set(type.name, v)
                }
                return v
            }

            // 对于具体类型（如 int、list(T) 等），递归实例化参数
            const out: MerType = { ...type }
            if ('args' in type) (out as predType | funcType | constructorType | typeType).args = type.args.map(instantiate)
            if ('result' in type && type.result) (out as funcType).result = instantiate(type.result)
            return out as LType
        }

        const args = sig.kind === 'pred' || sig.kind === 'func'
            ? (sig as predType | funcType).args.map(instantiate)
            : sig.kind === 'constructor'
            ? (sig as constructorType).args.map(instantiate)
            : []

        const result = sig.kind === 'func' && (sig as funcType).result
            ? instantiate((sig as funcType).result)
            : undefined

        return { args, result }
    }
    
    // ==================== 阶段 3：结果提取 ====================
    
    /**
     * 提取结果
     */
    private extractResults(
        doc: MercuryDocument,
        varMap: Map<string, LVar>,
        inferred: Map<Term, InferredInfo>
    ) {
        for (const clause of doc.parseResult.value.args) {
            this.extractClauseResults(clause as Clause, varMap, inferred)
        }

        // 提取调用约束中选中的类别
        const constraints = (doc as ExtendedMercuryDocument).constraints
        if (constraints) {
            for (const constraint of constraints) {
                if (constraint.kind === 'call') {
                    const callConstraint = constraint as CallConstraint
                    const category = callConstraint.selectedCategory
                    if (category) {
                        const existing = inferred.get(callConstraint.term)
                        if (existing) {
                            existing.category = category
                        } else {
                            inferred.set(callConstraint.term, { type: varType('?0'), category })
                        }
                    }
                }
            }
        }
    }
    
    /**
     * 提取子句结果
     */
    private extractClauseResults(
        clause: Clause,
        varMap: Map<string, LVar>,
        inferred: Map<Term, InferredInfo>
    ) {
        // 提取变量的类型
        for (const [varName, varTerms] of clause.varMap.entriesGroupedByKey()) {
            const lv = varMap.get(varName)
            if (lv) {
                const resolved = resolve<MerType>(lv, () => varType('?0'))
                for (const term of varTerms) {
                    inferred.set(term, { type: resolved })
                }
            }
        }

        // 提取非变量项的类型
        const termVars = (clause as ExtendedClause).termVars
        if (termVars) {
            for (const [term, lv] of termVars) {
                const resolved = resolve<MerType>(lv, () => varType('?0'))
                inferred.set(term, { type: resolved })
            }
        }

        // 后处理：为嵌套项推导类型
        this.propagateNestedTypes(clause, inferred)
    }

    /**
     * 为嵌套项推导类型
     */
    private propagateNestedTypes(clause: Clause, inferred: Map<Term, InferredInfo>) {
        for (const term of this.getAllTerms(clause.term)) {
            const info = inferred.get(term)
            if (!info) continue

            this.propagateTypeToSubterms(term, info.type, inferred)
        }
    }

    /**
     * 获取子句中的所有项
     */
    private getAllTerms(term: Term): Term[] {
        const terms: Term[] = [term]
        for (const arg of term.args) {
            terms.push(...this.getAllTerms(arg))
        }
        return terms
    }

    /**
     * 将类型传播到子项
     */
    private propagateTypeToSubterms(term: Term, type: MerType, inferred: Map<Term, InferredInfo>) {
        // 如果是 list(T) 类型，且 term 是列表构造子 [|]/2
        if (type.kind === 'type' && type.name === 'list' && type.args.length > 0) {
            const elemType = type.args[0]

            if (term.nameArity === '[|]/2') {
                // 列表构造子 [Head | Tail]
                const head = term.args[0]
                const tail = term.args[1]

                // 为 head 设置元素类型（int），而不是列表类型
                // 总是设置，因为 head 的类型是元素类型，不是列表类型
                inferred.set(head, { type: elemType })
                // 为 tail 设置列表类型
                inferred.set(tail, { type: type })

                // 递归处理子项
                this.propagateTypeToSubterms(head, elemType, inferred)
                this.propagateTypeToSubterms(tail, type, inferred)
            } else if (term.nameArity === '@/2') {
                // 项注解 Term @ Ann
                const lhs = term.args[0]
                const rhs = term.args[1]

                // 为 lhs 和 rhs 设置类型
                if (!inferred.has(lhs)) {
                    inferred.set(lhs, { type: type })
                }
                if (!inferred.has(rhs)) {
                    inferred.set(rhs, { type: type })
                }

                // 递归处理子项
                this.propagateTypeToSubterms(lhs, type, inferred)
                this.propagateTypeToSubterms(rhs, type, inferred)
            }
        } else if (term.nameArity === '@/2') {
            // 项注解 Term @ Ann（即使不是 list 类型）
            const lhs = term.args[0]
            const rhs = term.args[1]

            if (!inferred.has(lhs)) {
                inferred.set(lhs, { type: type })
            }
            if (!inferred.has(rhs)) {
                inferred.set(rhs, { type: type })
            }

            this.propagateTypeToSubterms(lhs, type, inferred)
            this.propagateTypeToSubterms(rhs, type, inferred)
        } else {
            // 对于其他项，递归处理所有子项
            for (const arg of term.args) {
                // 如果子项没有推断类型，尝试从父类型推导
                if (!inferred.has(arg)) {
                    // 这里可以添加更多逻辑来处理复合类型的子项
                    // 目前先不处理，让它保持未推断状态
                }
                // 递归处理
                this.propagateTypeToSubterms(arg, type, inferred)
            }
        }
    }
    
    /**
     * 设置未知类型
     */
    private setUnknownTypes(doc: MercuryDocument, inferred: Map<Term, InferredInfo>) {
        for (const clause of doc.parseResult.value.args) {
            for (const [varName, varTerms] of (clause as Clause).varMap.entriesGroupedByKey()) {
                for (const term of varTerms) {
                    inferred.set(term, { type: varType('?0') })
                }
            }
        }
    }
}

// ==================== 类型声明 ====================

interface CallConstraint {
    kind: 'call'
    term: Term
    candidates: TypeCandidate[]
    argVars: (LVar | undefined)[]
    resultVar?: LVar
    selectedCategory?: 'pred' | 'func' | 'constructor'
}

// 扩展 MercuryDocument 接口以存储约束
interface ExtendedMercuryDocument extends MercuryDocument {
    constraints?: Constraint[]
}

// 扩展 Clause 接口以存储项变量
interface ExtendedClause extends Clause {
    termVars?: Map<Term, LVar>
}