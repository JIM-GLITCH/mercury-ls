# Mercury LS 类型推断 — 现状与后续方向

> 记录 2025-02 推断引擎改造的最终状态、已修问题、已知权衡和下一步建议。
> 下次继续时先读本文 + `server/src/document-visitor.ts` 的「阶段 2」注释段。

## 架构现状

```
parse → visit(索引+可选推断) → link → validate
```

- **索引阶段**(`visitClause` 前半）：收集定义/引用/导出/imports/类型/函数签名，
  写入 `visitResult` 各 Map + `ExportManager`/`ModuleManager` 全局索引。
- **推断阶段**(`inferClause`，可关）：子句级自下而上合一，产出 `inferred`
  (Map<Term, InferredInfo>)，供 hover/definition/linker 消歧消费。
- **懒推断**:`document-builder.ts` 只对 priority(打开/编辑)或此前已推断过的
  文档跑 `inferClause`；未打开文档 `inferred` 为空，linker 走 `resolveRefKind` 兜底。
  打开文件后 `didOpen → update(changed) → priority` 自动补推断。

## 类型表示（document-type.ts)

- `MerType = var{name} | ctor{TypeCtor{name,arity,module?}, args[]} | ho{pf,args,result}`
  —— TypeCtor 带 module/限定名（`io.error`→module 'io'）；hover 显示 `module.name`
- 推断期类型项已迁移为 `LType = Logical<MerType>`（见文末 LogicVar 迁移
  计划）；`subst`/`applySubst`/MerType `unify` 已从推断路径移除
  （document-type.ts 中 unify/applySubst 暂保留未删）
- `tryUnify` 克隆 subst 试合一，成功才提交 → 天然事务性
- `freshenType/freshenSig/freshenCons` 实例化多态签名/构造子（`T`→`T#3`，
  `merTypeToString` 显示时剥 `#n`）
- `typeHeadParts`:`./2` 限定类型名链（`io.error`/`msi.stream_info`）拆出
  最内层名字 + 点分限定符；**声明（beginTypeInfo）与引用（termToMerType）
  都走它**，引用侧再由 `toMerType`/`typeModuleOf` 按「本模块→导出索引
  唯一命中」补齐 module；跨模块同名歧义保持未解析（unify 通配）

## 关键机制

### 冻结队列（freeze/2 语义，document-visitor.ts ~L97-110, 1814+)

- 消歧失败的 functor 登记 `{term, watches, goal}` 到子句级 `frozen`
- `tryUnify` 提交成功后 `drainFrozen()`：只对 watch 解析键变化的 goal 评分/重试
- **三条铁律**（都是 psqueue 卡死换来的）:
  1. `inTrialDepth>0` 禁止 push——trialSig 投机状态回滚时 frozen 不回滚，会污染；
  2. `frozenTerms` Set 去重——同一 Term 只挂一次；
  3. `pickSig` 在 `inTrialDepth>0` 时多候选直接判歧义——否则 trialSig→inferTerm
     →inferFunctor→pickSig→trialSig 无限递归（实测单子句 600 万次 inferTerm)。

### 同义词

- `resolveSynonym` 全量展开（assoc_list 等带参同义词，freshen 后用）
- `resolveGroundSynonym` 只展开 body 无类型变量的（`io`→`state`),
  `tryUnify`/`precheckSig` 两侧统一过它——**不对称展开会让 unify(io,state) 误失败**

### 重载消歧（pickSig/trialSig ~L2246+)

- `hasKnown`(quickArgType 含 inferred 回退）→ 对每个候选 `precheckSig` 廉价预检
  + `trialSig` 克隆态完整试解；全成功取类型变量最少者，并列/全失败 → undefined
- `verified=false` 只在「单候选+实参全未知」弱返回，歧义场景不采信
- 状态变量 `!X` 占两个语义参数位（`argWidth`)，签名字段按此对齐

### 性能要点

- `ExportManager` 有 `ctorIndex`(name/arity→count）和 typeMap/funcMap/altMap,
  **热路径禁止 `allTypeInfos()` 全表扫**
- `buildDocuments` 按 `scanHeader`+`orderByImports` 拓扑序 visit,priority 集合
  （打开文档+依赖祖先）提前

## 已验证的真实案例

- `io.m` 9 个 `insert_stream_info` 调用：修同义词不对称后全部拿到签名，
  `stream/4` 全部识别为 `stream_info.stream/4`（冻结唤醒生效）
- `psqueue.m`：全量 4186 文件索引下推断 51ms(此前单子句组合爆炸卡死 >6min)
- 测试：11 文件 140 用例全过（`bunx vitest run`,`server/` 下）

## 已知权衡 / 坑

1. **非限定类型名（已大部分解决）**:`TypeCtor.module` 已携带限定名，
   `unify` 对两侧都有 module 且不同的 ctor 判不匹配；未解析侧（builtin、
   跨模块同名歧义、声明早于类型定义的前向引用）仍按通配放行。
2. **hover 显示 `unknown`** = 推断 fresh 变量 `?N` 未绑定；linker 兜底可能
   标了 `(constructor)` 但推断侧仍无类别——先确认 server 已重启+文件被重访。
3. **推断失败静默**:`inferClause` 有 `catch {}`——调试时临时在 catch 里
   console.log 错误，否则异常被吞导致"签名明明在却没应用"的假象。
4. **依赖时序**：签名在依赖模块 visit 之后才注册时，本次 visit 拿不到；
   frozen 只能救"信息后至"，救不了"根本没查到"。根治需两阶段或
   `importedByDocs` 反向传播（目前是死字段）。
5. **trialSig 副作用**：试解会写 `inferred`，靠 pickSig 的 saved/rollback
   快照恢复；新增会写 inferred 的推断路径要注意这个不变量。

## 下一步候选（按价值排序）

1. **收集真实失败案例**：用户实际遇到推不出来的表达式，按案例决定重构范围
   ——不要凭感觉重写。
2. ~~TypeCtor 加 module/限定名~~ **已完成**：hover 可显示 `io.error`；
   遗留：前向引用（签名先于类型声明）与同名歧义引用的 module 仍缺省。
3. **mode/det 推导**:frozen 队列可直接挂第二类 goal（变量绑定后传播 mode
   约束）;`varMode`/`markVarMode` 已有基础。
4. **跨模块签名时序**:`importedByDocs` 填充 + 导出变化精确重访 importer,
   或全量"先索引后推断"两阶段。
5. **LogicVar/CHR 迁移**：仅当需要全局约束求解（跨子句 fixpoint）时再评估；
   参考历史 `8205a13`(freeze)、`51b26d6`（迁移）、`84a7aa1`（回退）。

## 常用命令

```bash
cd server && bunx vitest run          # 全量测试（140)
cd server && bunx tsc --noEmit        # 类型检查
cd . && bun run node esbuild.js       # 构建（server/out + client/out）
```

真实文件复现套路：临时 test 加载 `C:/Users/junyao/codespace/mercury/library/*.m`,
`documentFactory.fromString` + `Visitor.visit(doc, token, infer)` +
`exportManager.set(doc)`，分阶段计时定位。

## LogicVar 迁移计划（分支 infer-by-logicvar，2026-11-17 起）

> 已确认方向：逻辑变量 + freeze/2，**不要 CHR**。`8205a13` 版 logical-var.ts
> 已恢复（freeze/attrs/trail/runWithTrail/conj/disj 齐全，occurs check 保留，
> merTypeToString 已加 path-set 去环兜底）。前置重构已完成：sigAlts/typeIndex
> 均为 name-key 候选数组；签名消歧只剩 pickSig/trialSig；consByName O(1)。

### 目标架构

- 推断期类型项 = `Logical<MerType>`（下称 LType）；签名（FuncInfo/ConsInfo）
  保持纯 MerType 模板，每个使用点实例化成 LType（freshen → freshLogical）
- `varTypes` 值换 LType；`subst`/`tryUnify` 换 trail mark/undo（零克隆）
- frozen 队列 → freeze goal 挂变量 attr（消歧依赖的类型变量绑定时唤醒）；
  中期可先保留现有 frozen 机制跑通，再换 freeze
- 子句末 `resolve()` 一次落 MerType 写 `inferred`；inferred 的
  saved/rollback 快照机制整体删除（推迟写入即无回滚问题）
- wake goal 失败**不**回滚外层绑定（LS 容错），内部 try/catch 后重新 freeze
  或放弃——与求解器语义不同，刻意为之

### 分步

1. ~~**只换表示**~~ **已完成**：推断期类型项 = `LType = Logical<MerType>`
   （document-type.ts 导出）；签名/构造子/类型体模板每个使用点
   `instantiateSignature/instantiateCons/instantiate` 成活逻辑项
   （声明类型变量命名 `T#n`，fresh 变量 `?N`，varNames WeakMap 记显示名）；
   `subst`/`applySubst`/`unify`(MerType) 全部移除，合一走
   `unifyTypes`（自由变量→logical-var `unify` 绑 trail；具体节点→
   `unifyNodes` 按 MerType 语义递归：ctor name/arity+module 通配、
   ho pf/result 宽松），失败自动 undo trail。
2. ~~**换消歧**~~ **已完成**：trialSig/precheckSig 改 trail mark/undo +
   varTypes/varMode/pendingInferred 克隆回滚；`inferred` 推迟到子句末
   `solidify`（resolve）一次落盘——`refreshVarTypes`、pickSig 的
   saved/rollback、`collectArgTerms` 全部删除。推断期间内部读
   `pendingInferred`（活 ltype），`InferredInfo.ltype` 保留活引用。
3. ~~**换 freeze**~~ **已完成**：frozen {term,watches,goal} 队列删除，
   改 `freeze(v, goal, trail)` 把重试 goal 挂到消歧依赖的链尾自由变量
   （结果类型 + 直接变量实参）；goal 恒返回 true（LS 容错，不回滚），
   inTrialDepth>0 时被唤醒直接返回（队列由 trail undo 恢复）。
   `derefTerm`/`freeze` 已加进 logical-var.ts 导出。
   验证：165 测试全过；psqueue/io/assoc_list/list/array.m 单文件
   推断无异常。
4. **（可选）AC-lite**：共享变量的两个歧义项做联合过滤（arc consistency），
   不做 labeling/搜索。

### 关键文件

- `server/src/logical-var.ts`（已恢复，勿动 CHR）
- `server/src/document-visitor.ts` 推断段 ~L1650-2600
- `server/src/document-type.ts` unify/applySubst 被 unifyTypes/resolve 取代
- 参考：`git show 51b26d6:server/src/document-visitor.ts`（LType 用法）、
  `git show 837d03a:server/src/document-typeinfer.ts`（独立 pass 雏形）
