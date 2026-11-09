/******************************************************************************
 * CHR_Rule 的编译期类型断言。不是运行时测试：由 npm run check:static 里的
 * tsc -p server --noEmit 覆盖；@ts-expect-error 保证非法写法确实会报编译错误，
 * 若哪天校验失效，未使用的 @ts-expect-error 本身会让类型检查失败。
 ******************************************************************************/
import { CHR_Rule } from './logical-chr'
import type { RuleKindOfArray } from './chr-rule-syntax'
import { createLogicVar } from './logical-var'

type Assert<A, B> = [A] extends [B] ? ([B] extends [A] ? true : { got: A; want: B }) : { got: A; want: B }

const X = createLogicVar<number>()
const h1 = { a: X }
const h2 = { b: X }
const bodyTerm = { c: X }

const shape1 = [[h1], '<=>', [bodyTerm]] as const
const shape2 = [[h1], '==>', [bodyTerm]] as const
const shape3 = [[h1], '\\', [h2], '<=>', [bodyTerm]] as const
const k1: Assert<RuleKindOfArray<typeof shape1>, 'simplification'> = true
const k2: Assert<RuleKindOfArray<typeof shape2>, 'propagation'> = true
const k3: Assert<RuleKindOfArray<typeof shape3>, 'simpagation'> = true

const r1 = CHR_Rule(['name', '@', [h1, h2], '==>', () => true, '|', [bodyTerm]])
const k4: Assert<typeof r1.kind, 'propagation'> = true
const r2 = CHR_Rule([[h1], '<=>', [bodyTerm]])
const k5: Assert<typeof r2.kind, 'simplification'> = true
const r3 = CHR_Rule(['name', '@', [h1], '\\', [h2], '<=>', [bodyTerm]])
const k6: Assert<typeof r3.kind, 'simpagation'> = true
const r4 = CHR_Rule([[h1], '\\', [h2], '<=>'])
const k7: Assert<typeof r4.kind, 'simpagation'> = true
const r5 = CHR_Rule(['@', [h1], '<=>', [bodyTerm]])
const k8: Assert<typeof r5.kind, 'simplification'> = true

// 工厂写法：变量在内部创建，guard 直接读闭包变量，不再需要 env。
const r6 = CHR_Rule(() => {
  const Y = createLogicVar<number>()
  return [[{ a: Y }], '==>', () => Y.deref() === 7, '|', [{ hit: Y }]] as const
})
const k9: Assert<typeof r6.kind, 'propagation'> = true

// @ts-expect-error 工厂返回值必须 as const，否则 token 字面量被宽化
CHR_Rule(() => [[h1], '==>', [bodyTerm]])
// @ts-expect-error 工厂写法同样校验骨架
CHR_Rule(() => [[h1]] as const)
// @ts-expect-error 缺少 rule operator
CHR_Rule([[h1]])
// @ts-expect-error 重复 / 冲突的 operator
CHR_Rule([[h1], '<=>', '==>', [bodyTerm]])
// @ts-expect-error \ 只能配 <=>
CHR_Rule([[h1], '\\', [h2], '==>', [bodyTerm]])
// @ts-expect-error simpagation 缺少 removed head
CHR_Rule([[h1], '\\', '<=>', [bodyTerm]])
// @ts-expect-error 重复 |
CHR_Rule([[h1], '<=>', '|', [bodyTerm], '|', [h2]])
// @ts-expect-error guard 必须是函数
CHR_Rule([[h1], '<=>', 42, '|', [bodyTerm]])
// @ts-expect-error guard 最多一个
CHR_Rule([[h1], '<=>', () => true, () => true, '|', [bodyTerm]])
// @ts-expect-error body 段只能放 [...] 约束列表
CHR_Rule([[h1], '<=>', 'garbage'])
// @ts-expect-error head 段只能放 [...] 约束列表
CHR_Rule([() => true, '<=>', [bodyTerm]])
// @ts-expect-error head 不能为空
CHR_Rule([[], '<=>', [bodyTerm]])
// @ts-expect-error 规则名必须是字符串
CHR_Rule([42, '@', [h1], '<=>', [bodyTerm]])

void [X, shape1, shape2, shape3, k1, k2, k3, k4, k5, k6, k7, k8, k9, r1, r2, r3, r4, r5, r6]
