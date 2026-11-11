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
    varNameType: Map<string, LVar>
    constraints: Constraint[]
    termType: Map<Term, LVar>  // 项到逻辑变量的映射
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
    async inferDocument(doc: MercuryDocument, cancelToken: CancellationToken = CancellationToken.None) {
        const inferred = new Map<Term, InferredInfo>()
        doc.inferred = inferred



        for (const clause of doc.parseResult.value.args) {
            await interruptAndCheck(cancelToken)
            this.inferClause(clause)
        }
    }

    inferClause(clause: Clause) {
        if(clause.term.nameArity === ':-/2') {
            // 规则
            this.inferClause(clause.term.args[0])
            this.inferClause(clause.term.args[1])
        } else {
            // 事实
            this.inferClause(clause.term)
        }
    }

}