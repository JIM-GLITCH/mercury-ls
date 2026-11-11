import { beforeEach, describe, it, expect } from 'vitest'
import { URI } from 'vscode-uri'
import { CancellationToken } from 'vscode-languageserver'
import { createMercuryServices, type MercuryServices } from '../services'
import { merTypeToString } from '../document-type'
import type { MercuryDocument } from '../document-manager'
import type { Clause, Term } from '../term'

let services: MercuryServices
beforeEach(() => {
    services = createMercuryServices()
})

/** 建文档 → 全局 index → clause body 推导，返回可查 doc.inferred 的文档 */
async function infer(src: string, name: string): Promise<MercuryDocument> {
    const doc = services.documentFactory.fromString(src, URI.parse(`file:///${name}.m`))
    services.documents.addDocument(doc)
    await services.index.update(doc, CancellationToken.None)
    await services.typeInferer.inferDocument(doc)
    return doc
}

/** 取第 idx 条 clause 的定义头（去掉 rule body）与 func 结果项 */
function headOf(doc: MercuryDocument, idx: number): { head: Term; result?: Term } {
    const clause = doc.parseResult.value.args[idx] as Clause
    let t = clause.term
    if (t.nameArity === ':-/2') t = t.args[0]
    let head = t
    let result: Term | undefined
    if (t.nameArity === '=/2') {
        result = t.args[1]
        head = t.args[0]
    }
    return { head, result }
}

/** 推断类型的可读形式；未登记的 term 显式区分出来 */
function typeOf(doc: MercuryDocument, term: Term): string {
    const info = doc.inferred?.get(term)
    return info ? merTypeToString(info.type) : '(no inferred)'
}

/** 推断的类别（constructor/func/pred） */
function categoryOf(doc: MercuryDocument, term: Term): string {
    const info = doc.inferred?.get(term)
    return info?.category || '(no category)'
}

describe('typeinfer', () => {
    it('should infer type with list definition', async () => {
        // 首先添加 list 定义文件到全局索引
        const listDoc = services.documentFactory.fromString(`
            :- module list.
            :- interface.
            :- type list(T) ---> [] ; [T | list(T)].
            :- type poke ---> card(color,int).
            :- type color ---> red1|red2 | black1 |balck2
            :- implementation.
        `, URI.parse('file:///list.m'))
        services.documents.addDocument(listDoc)
        await services.index.update(listDoc, CancellationToken.None)

        // 然后添加测试文件
        const doc = await infer(`
            :- import_module list.
            :- pred p(poke).
            p(card(X,Y)).
            `, 'typeinfer')
        // Clause 0: import_module
        // Clause 1: pred declaration
        // Clause 2: rule p([X]) :- X = 1.
        const { head } = headOf(doc, 2)

        // 检查 p 的签名
        const pSignature = services.index.get('p')[0]?.signature
        console.log('p signature:', JSON.stringify(pSignature, null, 2))

        console.log('head.args[0] type:', typeOf(doc, head.args[0]))
        console.log('head.args[0].args[0] type:', typeOf(doc, head.args[0].args[0]))
        expect(typeOf(doc, head.args[0])).toBe('poke')
        expect(typeOf(doc, head.args[0].args[0])).toBe('color')
    })

    it('推导 pred fact 头参数变量', async () => {
        const doc = await infer(`
            :- pred q(int).
            q(Z).
            `, 'pred_fact')
        const { head } = headOf(doc, 1)
        expect(typeOf(doc, head.args[0])).toBe('int')
    })

    it('推导 func rule 的头参数与结果变量', async () => {
        const doc = await infer(`
            :- func f(int) = int.
            f(A) = B :- A = B.
            `, 'func_rule')
        const { head, result } = headOf(doc, 1)
        expect(typeOf(doc, head.args[0])).toBe('int')
        expect(typeOf(doc, result!)).toBe('int')
    })

    it('无声明时变量保持自由类型，且同名变量共享同一个逻辑变量', async () => {
        const doc = await infer('g(C) = C.', 'no_decl')
        const { head, result } = headOf(doc, 0)
        expect(typeOf(doc, head.args[0])).toBe('unknown')
        expect(typeOf(doc, result!)).toBe('unknown')
        expect(doc.inferred!.get(head.args[0])!.type)
            .toEqual(doc.inferred!.get(result!)!.type)
    })

    it('同一 clause 内同名变量推导出相同类型', async () => {
        const doc = await infer(`
            :- pred f(int, int).
            f(X, X).
            `, 'shared_var')
        const { head } = headOf(doc, 1)
        expect(typeOf(doc, head.args[0])).toBe('int')
        expect(typeOf(doc, head.args[1])).toBe('int')
        expect(doc.inferred!.get(head.args[0])!.type)
            .toEqual(doc.inferred!.get(head.args[1])!.type)
    })
    it('同一 clause 参数位置类型解构', async () => {
        const doc = await infer(`
            :- pred f(list(int)).
            f([X]).
            `, 'shared_var')
        const { head } = headOf(doc, 1)
        expect(typeOf(doc, head.args[0])).toBe('list(int)')
        expect(typeOf(doc, head.args[0].args[0])).toBe('int')
    })
    it('同一 clause 参数位置类型解构', async () => {
        const doc = await infer(`
            :- pred f(list(int)).
            f(X@[Y,Z]).
            `, 'shared_var')
        const { head } = headOf(doc, 1)
        // X@[Y,Z] is @(X, [Y|[Z|[]]])
        expect(typeOf(doc, head.args[0])).toBe('list(int)')
        expect(typeOf(doc, head.args[0].args[0])).toBe('list(int)')  // X is list(int)
        expect(typeOf(doc, head.args[0].args[1])).toBe('list(int)')  // [Y|[Z|[]]] is list(int)
        expect(typeOf(doc, head.args[0].args[1].args[0])).toBe('int')  // Y is int
        expect(typeOf(doc, head.args[0].args[1].args[1])).toBe('list(int)')  // [Z|[]] is list(int)
        expect(typeOf(doc, head.args[0].args[1].args[1].args[0])).toBe('int')  // Z is int
    })

    it('根据类型推导消除同名 pred/constructor 歧义', async () => {
        // 场景：同一个名字 'c' 既是 pred 又是 constructor
        // :- pred c(int).
        // :- type mytype ---> c(int).
        // :- pred p(mytype).
        // 在 p(c(1)) 中，c(1) 应该被识别为 constructor（返回 mytype）
        // 而不是作为 pred 调用（不返回值）
        //
        // 这是 CLP（约束逻辑编程）类型推导的核心优势：
        // 通过收集类型约束并统一求解，可以根据上下文类型自动选择正确的候选
        // 从而消除同名符号的歧义
        const doc = await infer(`
            :- pred p(mytype).
            :- pred c(int).
            :- type mytype ---> c(int).
            p(c(1)).
            `, 'disambiguate')
        const { head } = headOf(doc, 3)
        // c(1) 应该被识别为 constructor
        expect(categoryOf(doc, head.args[0])).toBe('constructor')
        // c(1) 的类型应该是 mytype（constructor 返回 mytype）
        expect(typeOf(doc, head.args[0])).toBe('mytype')
    })

    it('根据类型推导消除同名 func/pred 歧义', async () => {
        // 场景：同一个名字 'f' 既是 func 又是 pred
        // :- func f(int) = int.
        // :- pred f(int).
        // 在 p(f(1)) 中，f(1) 应该被识别为 func（因为 p 需要一个 int 参数）
        // 而不是作为 pred 调用
        //
        // CLP 求解器会尝试所有候选，选择与类型约束一致的选项
        // 这里 f(int) = int 符合 p(int) 的签名，而 pred f(int) 不返回值
        // 因此会选择 func 候选
        const doc = await infer(`
            :- func f(int) = int.
            :- pred f(int).
            :- pred p(int).
            p(f(1)).
            `, 'disambiguate_func')
        const { head } = headOf(doc, 3)
        // f(1) 应该被识别为 func
        expect(categoryOf(doc, head.args[0])).toBe('func')
        // f(1) 作为 func 调用返回 int，所以参数是 int
        expect(typeOf(doc, head.args[0])).toBe('int')
    })

    it('clause body 中的变量类型推导', async () => {
        // 测试 body 中的变量从调用结果推导类型
        const doc = await infer(`
            :- func f(int) = int.
            :- pred p(int).
            p(X) :- X = f(1).
            `, 'body_var_infer')
        const clause = doc.parseResult.value.args[2] as Clause  // p(X) :- X = f(1)
        // X 从 f(1) 的返回值推导出 int 类型
        const xTerm = clause.varMap.get('X')?.[0]
        expect(typeOf(doc, xTerm!)).toBe('int')
    })

    it('clause body 中的同名调用歧义消除', async () => {
        // 在 body 中根据上下文消除同名调用歧义
        const doc = await infer(`
            :- func f(int) = int.
            :- pred f(int).
            :- pred p(int).
            p(X) :- X = f(1).
            `, 'body_disambiguate')
        const clause = doc.parseResult.value.args[3] as Clause
        // body 中的 f(1) 应该被识别为 func
        const bodyTerm = clause.term.args[1] as Term  // body 部分
        const fCall = bodyTerm.args[1] as Term  // f(1)
        expect(categoryOf(doc, fCall)).toBe('func')
    })

    it('clause body 中的构造子歧义消除', async () => {
        // 在 body 中根据上下文消除构造子/谓词歧义
        const doc = await infer(`
            :- pred p(mytype).
            :- pred c(int).
            :- type mytype ---> c(int).
            p(X) :- X = c(1).
            `, 'body_ctor_disambiguate')
        const clause = doc.parseResult.value.args[3] as Clause
        // body 中的 c(1) 应该被识别为 constructor
        const bodyTerm = clause.term.args[1] as Term  // body 部分
        const cCall = bodyTerm.args[1] as Term  // c(1)
        expect(categoryOf(doc, cCall)).toBe('constructor')
        expect(typeOf(doc, cCall)).toBe('mytype')
    })

    it('clause body 中的复合表达式类型推导', async () => {
        // 测试 body 中复合表达式的类型推导
        const doc = await infer(`
            :- func f(int) = int.
            :- func g(int) = int.
            :- pred p(int).
            p(X) :- X = g(f(1)).
            `, 'body_compound')
        const clause = doc.parseResult.value.args[3] as Clause
        // X 从 g(f(1)) 的返回值推导出 int 类型
        const xTerm = clause.varMap.get('X')?.[0]
        expect(typeOf(doc, xTerm!)).toBe('int')
    })

    it('clause body 中的嵌套调用歧义消除', async () => {
        // 测试嵌套调用中的歧义消除
        const doc = await infer(`
            :- func f(int) = int.
            :- pred f(int).
            :- func g(int) = int.
            :- pred p(int).
            p(X) :- X = g(f(1)).
            `, 'body_nested_disambiguate')
        const clause = doc.parseResult.value.args[4] as Clause
        const bodyTerm = clause.term.args[1] as Term  // body 部分
        const gCall = bodyTerm.args[1] as Term  // g(f(1))
        const fCall = gCall.args[0] as Term  // f(1)
        // g 应该是 func
        expect(categoryOf(doc, gCall)).toBe('func')
        // f 也应该是 func（因为 g 的参数是 int）
        expect(categoryOf(doc, fCall)).toBe('func')
    })

    it('高阶函数类型推导', async () => {
        // 测试高阶函数的类型推导
        const doc = await infer(`
            :- func map(func(int) = int, list(int)) = list(int).
            :- func f(int) = int.
            :- pred p(list(int)).
            p(map(f, [1,2,3])).
            `, 'higher_order')
        const { head } = headOf(doc, 3)
        // map(f, [1,2,3]) 返回 list(int)
        expect(typeOf(doc, head.args[0])).toBe('list(int)')
    })

    it('部分应用函数类型推导', async () => {
        // 测试部分应用的类型推导
        const doc = await infer(`
            :- func add(int, int) = int.
            :- pred p(func(int) = int).
            p(add(1)).
            `, 'partial_application')
        const { head } = headOf(doc, 2)
        // add(1) 是部分应用，返回 func(int) = int
        // 内部表示为 =(func(int), int)
        expect(typeOf(doc, head.args[0])).toBe('=(func(int), int)')
    })

    it('柯里化函数链式调用', async () => {
        // 测试柯里化函数的链式调用
        const doc = await infer(`
            :- func compose(func(int) = int, func(int) = int) = func(int) = int.
            :- func f(int) = int.
            :- func g(int) = int.
            :- pred p(func(int) = int).
            p(compose(f, g)).
            `, 'currying_chain')
        const { head } = headOf(doc, 4)
        // compose(f, g) 返回 func(int) = int
        // 内部表示为 =(func(int), int)
        expect(typeOf(doc, head.args[0])).toBe('=(func(int), int)')
    })

    it('高阶谓词类型推导', async () => {
        // 测试高阶谓词的类型推导
        const doc = await infer(`
            :- func foldl(pred(int, int, int), int, list(int)) = int.
            :- pred sum(int, int, int).
            :- pred p(int).
            p(foldl(sum, 0, [1,2,3])).
            `, 'higher_order_pred')
        const { head } = headOf(doc, 3)
        // foldl(sum, 0, [1,2,3]) 返回 int
        expect(typeOf(doc, head.args[0])).toBe('int')
    })

    it('body 中 X = f(xxx) 的高阶函数赋值', async () => {
        // 测试 body 中将部分应用的函数赋值给变量
        const doc = await infer(`
            :- func f(int) = int.
            :- pred p(int).
            p(Y) :- X = f(1), Y = X.
            `, 'body_func_assign')
        const clause = doc.parseResult.value.args[2] as Clause
        // X 从 f(1) 推导出 int
        const xTerm = clause.varMap.get('X')?.[0]
        expect(typeOf(doc, xTerm!)).toBe('int')
        // Y 从 X 推导出 int
        const yTerm = clause.varMap.get('Y')?.[0]
        expect(typeOf(doc, yTerm!)).toBe('int')
    })

    it('body 中 Y = X(xxx) 的高阶函数调用', async () => {
        // 测试 body 中通过变量调用函数
        const doc = await infer(`
            :- func apply(func(int) = int, int) = int.
            :- func f(int) = int.
            :- pred p(int).
            p(Y) :- X = f, Y = apply(X, 1).
            `, 'body_higher_order_call')
        const clause = doc.parseResult.value.args[3] as Clause
        // X 是函数类型
        const xTerm = clause.varMap.get('X')?.[0]
        expect(typeOf(doc, xTerm!)).toBe('=(func(int), int)')
        // Y 从 apply(X, 1) 推导出 int
        const yTerm = clause.varMap.get('Y')?.[0]
        expect(typeOf(doc, yTerm!)).toBe('int')
    })

    it('body 中嵌套的高阶函数链', async () => {
        // 测试 body 中嵌套的高阶函数调用链
        const doc = await infer(`
            :- func compose(func(int) = int, func(int) = int) = func(int) = int.
            :- func f(int) = int.
            :- func g(int) = int.
            :- pred p(int).
            p(Y) :- X = compose(f, g), Y = X(1).
            `, 'body_nested_higher_order')
        const clause = doc.parseResult.value.args[4] as Clause
        // Y 从 X(1) 推导出 int
        const yTerm = clause.varMap.get('Y')?.[0]
        expect(typeOf(doc, yTerm!)).toBe('int')
    })

    it('body 中通过部分应用传递函数', async () => {
        // 测试 body 中部分应用并传递函数
        const doc = await infer(`
            :- func add(int, int) = int.
            :- func apply(func(int) = int, int) = int.
            :- pred p(int).
            p(Y) :- X = add(1), Y = apply(X, 2).
            `, 'body_partial_apply')
        const clause = doc.parseResult.value.args[3] as Clause
        // X 是部分应用的函数
        const xTerm = clause.varMap.get('X')?.[0]
        expect(typeOf(doc, xTerm!)).toBe('=(func(int), int)')
        // Y 从 apply(X, 2) 推导出 int
        const yTerm = clause.varMap.get('Y')?.[0]
        expect(typeOf(doc, yTerm!)).toBe('int')
    })

    it('body 中多个变量的类型推导链', async () => {
        // 测试 body 中多个变量的类型推导链
        const doc = await infer(`
            :- func f(int) = int.
            :- func g(int) = int.
            :- pred p(int).
            p(Z) :- X = f(1), Y = g(X), Z = Y.
            `, 'body_var_chain')
        const clause = doc.parseResult.value.args[3] as Clause
        // X 从 f(1) 推导出 int
        const xTerm = clause.varMap.get('X')?.[0]
        expect(typeOf(doc, xTerm!)).toBe('int')
        // Y 从 g(X) 推导出 int
        const yTerm = clause.varMap.get('Y')?.[0]
        expect(typeOf(doc, yTerm!)).toBe('int')
        // Z 从 Y 推导出 int
        const zTerm = clause.varMap.get('Z')?.[0]
        expect(typeOf(doc, zTerm!)).toBe('int')
    })

    it('整数字面量 1 在 float 上下文里是 float', async () => {
        const doc = await infer(`
            :- pred p(float).
            p(X) :- X = 1.
            `, 'literal_float')
        const clause = doc.parseResult.value.args[1] as Clause
        expect(typeOf(doc, clause.term.args[1].args[1])).toBe('float')
    })

    it('整数字面量 1 在 uint 上下文里是 uint', async () => {
        const doc = await infer(`
            :- pred p(uint).
            p(X) :- X = 1.
            `, 'literal_uint')
        const clause = doc.parseResult.value.args[1] as Clause
        expect(typeOf(doc, clause.term.args[1].args[1])).toBe('uint')
    })

    it('1 不会把 list(float) 的元素硬钉成 int', async () => {
        const doc = await infer(`
            :- pred p(list(float)).
            p([X]) :- X = 1.
            `, 'literal_list_float')
        const { head } = headOf(doc, 1)
        expect(typeOf(doc, head.args[0])).toBe('list(float)')
        expect(typeOf(doc, head.args[0].args[0])).toBe('float')
    })

    it('无上下文时整数字面量 1 默认 int', async () => {
        const doc = await infer('q(1).', 'literal_default')
        expect(typeOf(doc, headOf(doc, 0).head.args[0])).toBe('int')
    })

    it('整数字面量 1 会排除类型不匹配的重载候选', async () => {
        const doc = await infer(`
            :- pred p(string).
            :- pred p(int).
            p(1).
            `, 'literal_candidate')
        const { head } = headOf(doc, 2)
        expect(typeOf(doc, head.args[0])).toBe('int')
        expect(categoryOf(doc, head)).toBe('pred')
    })

    it('name 拆成 callee 后两层类型分离：p :: func(int)=int，p(1) :: int', async () => {
        const doc = await infer(`
            :- func p(int) = int.
            :- pred q(int).
            q(p(1)).
            `, 'callee_split')
        const { head } = headOf(doc, 2)   // q(p(1))
        const call = head.args[0]          // p(1)
        // 应用项 p(1) 的类型是结果类型 int
        expect(typeOf(doc, call)).toBe('int')
        // 名字 callee 的类型是函数签名本身 int -> int
        const callee = call.callee!
        expect(callee).toBeDefined()
        expect(typeOf(doc, callee)).toBe('func(int) = int')
        expect(categoryOf(doc, callee)).toBe('func')
    })

    it('构造子的 callee 与应用项同样分离：ctor 自身类型 ctor(int)，ctor(1) :: mytype', async () => {
        const doc = await infer(`
            :- type mytype ---> ctor(int).
            :- pred q(mytype).
            q(ctor(1)).
            `, 'callee_ctor')
        const { head } = headOf(doc, 2)   // q(ctor(1))
        const call = head.args[0]          // ctor(1)
        expect(typeOf(doc, call)).toBe('mytype')
        const callee = call.callee!
        expect(callee).toBeDefined()
        // 构造子符号 ctor 自身的类型（int -> mytype）渲染为 ctor(int)，与应用项 ctor(1) 的 mytype 区分开
        expect(typeOf(doc, callee)).toBe('ctor(int)')
        expect(categoryOf(doc, callee)).toBe('constructor')
    })

    it('infix 应用项把名字拆成独立 callee：1+2 :: int，callee 名字为 +', async () => {
        const doc = await infer(`
            :- pred q(int).
            q(1 + 2).
            `, 'callee_infix')
        const { head } = headOf(doc, 1)   // q(1 + 2)
        const call = head.args[0]          // 1 + 2
        expect(typeOf(doc, call)).toBe('int')
        const callee = call.callee!
        expect(callee).toBeDefined()
        // 内建 + 不一定进全局索引，故只验证名字被拆出、应用项类型正确
        expect(callee.name).toBe('+')
    })
})
