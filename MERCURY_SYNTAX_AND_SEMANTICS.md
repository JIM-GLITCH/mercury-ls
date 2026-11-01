# Mercury 语言语法与语义文档

> 本文档基于对 Mercury 编译器源码（位于仓库 `compiler/`、标准库 `library/`）的分析整理而成，
> 同时以官方参考手册 `doc/mercury_reference_manual.texi` 作为语义描述的权威依据。
> 所有“语法规则”均可在源码的解析器模块中找到对应的解析逻辑；文中标注了关键源码位置（`file:line`）以便追溯。

---

## 目录

1. [概述与编译流程](#1-概述与编译流程)
2. [词法结构](#2-词法结构)
3. [模块系统](#3-模块系统)
4. [抽象语法总览](#4-抽象语法总览)
5. [声明（Declarations / Items）](#5-声明declarations--items)
6. [类型系统](#6-类型系统)
7. [实例化与模式（Insts & Modes）](#7-实例化与模式insts--modes)
8. [确定性（Determinism）](#8-确定性determinism)
9. [项、目标与表达式](#9-项目标与表达式)
10. [合一（Unification）](#10-合一unification)
11. [类型类与约束多态](#11-类型类与约束多态)
12. [高阶（Higher-order）](#12-高阶higher-order)
13. [DCG 语法糖](#13-dcg-语法糖)
14. [Pragma（编译器指令）](#14-pragmapragma编译器指令)
15. [形式语义](#15-形式语义)
16. [源码索引](#16-源码索引)

---

## 1. 概述与编译流程

Mercury 是一门**强类型、强模式（mode）、确定性（determinism）声明式**的逻辑/函数式编程语言。
编译器本身用 Mercury 编写（`compiler/*.m`）。源码处理的顶层数据结构是：

- **`term(T)`**：词法/项读取阶段的数据项（`library/term.m:43-70`）。
- **`item`**：解析后的顶层声明/条款（clause）的统一 AST 根类型（`compiler/prog_item.m:83-104`）。
- **`goal`**：目标（合取、析取、调用、量化等）的 AST（`compiler/prog_item.m:622-775`）。

解析派发流程：词法器 → 项读取器（`library/mercury_term_parser.m`）→ `parse_item.m`
（`parse_item_or_marker` → `parse_decl_item_or_marker`, `parse_item.m:148-340`）按 **functor 名**
把 `:- Functor(...)` 派发到 `parse_type_defn.m`、`parse_inst_mode_defn.m`、`parse_class.m`、
`parse_pragma.m` 等专项解析器。注意：类型/实例/模式被**直接**解析为 `mer_type` / `mer_inst` /
`mer_mode`，中间没有 `type_expr` / `inst_expr` / `mode_expr` 这样的中间 AST。

---

## 2. 词法结构

依据 `doc/mercury_reference_manual.texi`（Syntax 章节，行 161-1022）。

### 2.1 字符集
源文件必须使用 **UTF-8** 编码；“字母/数字/下划线”指 Basic Latin 区块字符。

### 2.2 空白符
空格（U+0020）、水平制表（U+0009）、换行（U+000A）、垂直制表（U+000B）、换页（U+000C）、回车（U+000D）。

### 2.3 注释
- `%` 起到行尾为止的单行注释。
- `/* ... */` 块注释，可跨行。

### 2.4 行号指令
`#<正整数>` 设置后续行的行号，配合 `:- pragma source_file(...)` 用于生成代码的错误定位。

### 2.5 变量
- 大写字母或下划线开头，后接字母/下划线/数字：`Sum`、`_NotNeeded`、`_a`、`_123` 是变量；`x`、`_#` 不是。
- 单个 `_` 每次出现都表示**互不相同**的匿名变量。
- 大写开头变量被期望出现多次（否则编译器警告，可能是笔误）；下划线开头变量视为“不在乎”变量。

### 2.6 名字（name）
- **非引号名**：小写字母开头，后接字母/下划线/数字。
- **引号名**：单引号 `'...'` 包裹的任意字符序列（连续两个单引号表示一个单引号；支持与字符串相同的反斜杠转义）。
- **图形名（graphic name）**：由一个或多个图形字符组成的序列：
  ```
  ! & * + - : < = > ? @ ^ ~ \ # $ . /
  ```
  其中首字符不能是 `#`。特殊情形：`<<u` 与 `>>u` 亦为图形名（分别表示无符号左/右移位）。
- 非引号名、图形名、分号在解析时等价于包含相同字符序列的引号名。

### 2.7 字面量
- **字符串**：双引号 `"..."` 包裹；`""` 表示单个双引号；支持 `\a \b \e \f \n \r \t \v`、十六进制 `\x..\`、八进制 `\...\`、Unicode `\uXXXX` / `\UXXXXXXXX` 转义；`\<换行>` 被删除（用于续行）。
- **整数**：十进制、二进制 `0b...`、八进制 `0o...`、十六进制 `0x...`、字符码 `0'c`。可带后缀表示有无符号及位宽（如 `i8/u32`）。
- **浮点**：如 `3.14`、科学计数 `1.0e-3`。
- **字符**：单引号包裹的单字符，如 `'a'`。

### 2.8 操作符与优先级
操作符表定义在 `library/ops.m`。解析树层面不存在任何“表达式类型”，**算术/比较/函数调用**
统统只是带操作符的 **term**（`functor(atom(OpName), Args)`）。部分内置操作符：

| 操作符 | 优先级 | 结合性 | 语义 | 源码 |
|--------|-------|--------|------|------|
| `:=` | 850 | `arg_gt, arg_gt` | 破坏式（destructive）赋值 | `library/ops.m:628` |
| `==>` | 850 | | 约束蕴含 | `library/ops.m:629` |
| `=^` | 850 | | | `library/ops.m:630` |
| `@` | 1410 | `arg_gt, arg_gt` | 项注解 | `library/ops.m:631` |

用户可用 `:- infixl/infixr/infix/prefix/postfix` 在读期（`library/mercury_term_parser.m`）声明自定义操作符。

---

## 3. 模块系统

模块标记语法（解析于 `parse_module.m`，派发于 `parse_item.m:218-228`）：

```mercury
:- module <ModuleName>.
:- interface.
:- implementation.
:- end_module <ModuleName>.
```

- 模块名即 `sym_name`，可限定（如 `a.b.c`）。
- `:- module` / `:- end_module` 仅接受**单个**模块名，无“模块属性”列表语法。
- `:- interface.` / `:- implementation.` **不接受任何参数**。

导入/使用/包含（派发 `parse_item.m:230-235`，解析 `parse_item.m:698-764`）：

```mercury
:- import_module  <Mod1, Mod2, ...>.   % 完全导入（可不带限定使用）
:- use_module     <Mod1, Mod2, ...>.   % 使用（必须带模块限定）
:- include_module <Mod1, Mod2, ...>.   % 引入（嵌套）子模块
```

- `import_module` 比 `use_module` 授予更多可见性；接口区声明比实现区授予更多可见性
  （`compiler/prog_parse_tree.m:101-178`）。
- `include_module` 的子模块内容可直接写在同文件中，AST 用 `mc_nested_submodule`
  （`compiler/prog_parse_tree.m:225-237`）表示。
- **本版本不支持** `import_module M only [...]` / `except [...]` 限定（`parse_incl_imp_use_items` 仅解析模块名列表）。

源代码结构：`parse_tree_src`（模块名 + 组件列表），每个 `module_component` 为 `mc_section` 或 `mc_nested_submodule`。

---

## 4. 抽象语法总览

顶层 AST 根类型是 `item`（`compiler/prog_item.m:83-104`）：

```
item ---> item_clause(item_clause_info)              % 子句（事实/规则）
        ; item_type_defn(item_type_defn_info)        % 类型定义
        ; item_inst_defn(item_inst_defn_info)        % 实例(inst)定义
        ; item_mode_defn(item_mode_defn_info)        % 模式(mode)定义
        ; item_pred_decl(item_pred_decl_info)        % 谓词声明
        ; item_mode_decl(item_mode_decl_info)        % 谓词模式声明
        ; item_foreign_proc(item_foreign_proc_info)  % 外部过程
        ; item_foreign_enum(...)
        ; item_foreign_export_enum(...)
        ; item_decl_pragma(...)                      % 声明段 pragma
        ; item_impl_pragma(...)                       % 实现段 pragma
        ; item_promise(...)                           % 断言 promise
        ; item_typeclass(item_typeclass_info)         % 类型类
        ; item_instance(item_instance_info)           % 实例
        ; item_initialise / item_finalise             % 模块初始化/收尾
        ; item_mutable(...)                           % 可变状态
        ; item_type_repn(...).                        % 类型表示
```

项 AST（`library/term.m:43-70`）：

```
term(T) ---> functor(const, list(term(T)), term_context)
          ;  variable(var(T), term_context).

const   ---> atom(string)
          ;  integer(integer_base, integer_value, signedness, integer_size)
          ;  string(string)
          ;  float(float)
          ;  implementation_defined(string).
```

目标 AST（`compiler/prog_item.m:622-775`）核心是：

```
goal ---> unify_expr(Ctx, Term, Term, Purity)        % X = Y
      ;   call_expr(Ctx, SymName, list(Term), Purity) % p(X)
      ;   conj_expr(Ctx, Goal, list(Goal))           % ,
      ;   true_expr(Ctx)                             % true
      ;   if_then_else_expr(Ctx, Vars, Vars, Goal, Goal, Goal)
      ;   disj_expr(Ctx, Goal, Goal, list(Goal))     % ;
      ;   not_expr(Ctx, Goal)                        % not / \+
      ;   fail_expr(Ctx)                             % fail
      ;   par_conj_expr(Ctx, Goal, list(Goal))       % &
      ;   quant_expr(quant_type, quant_vars_kind, Ctx, list(Var), Goal)  % some/all
      ;   implies_expr(Ctx, Goal, Goal)              % <= / =>
      ;   equivalent_expr(Ctx, Goal, Goal)           % <=>
      ;   trace_expr(...)                            % trace [...]
      ;   atomic_expr(...)                           % atomic [...]
      ;   try_expr(...)                              % try/catch
      ;   event_expr(Ctx, string, list(Term))       % event "..."
      ;   ... (promise_*/require_* 标注类构造函数)
```

---

## 5. 声明（Declarations / Items）

所有声明均以 `:- Functor(...)` 形式出现，由 `parse_item.m` 按 functor 名派发。

以下每小节均分两部分：**语法**（符号在哪里**定义**）与**可被引用的位置**（符号在哪里**被使用**）。
二者的区分正是定义/引用索引（跳转到定义、查找引用）的依据；同一符号可在多个位置被引用，
但定义位置唯一（含多处子句定义时按 head 归并）。注意：构造子与 pred/func 调用在解析树层
**同形**（都是 functor），归类延迟到类型检查/linker 阶段（见 §5.1、§9.1）。

**LS 实现的索引结构**（`document-visitor.ts`，均随 `VisitResult` 输出）：

| 索引 | 内容 | 跳转定义 | 查找引用 |
|---|---|---|---|
| `definition` | 类型 / 构造子（`constructor`）/ inst / mode / typeclass / instance / mutable / 子句定义 | ✅ 按引用的 semanticType 类别过滤（type 引用不会命中同名 inst 定义） | — |
| `declaration` | `:- pred/func` 声明（与子句定义分离） | ✅（go to declaration） | — |
| `reference` | 子句体里的 pred/func/构造子调用、模块名 | — | ✅（default 分支） |
| `typeReference` | 类型引用位置（见 §5.1 标注） | — | ✅（`case 'type'`） |
| `instReference` | inst 引用位置（见 §5.2 标注） | — | ✅（`case 'inst'`） |
| `modeReference` | mode 引用位置（见 §5.3 标注） | — | ✅（`case 'mode'`） |

引用 term 带 `semanticArity`（语义元数）时（`Type/Arity` 写法、DCG `+2`），
hover 显示与定义/引用匹配均按语义元数进行（`utils.ts: semanticArityOf`）。
表达式/数据位置的 functor 引用（如 `version_array.init(...)`、构造子）解析层无法
区分类别（不标 `semanticType`）：**linker 阶段**按名字与语义元数到 definition/declaration
消解——本模块 + **全局导出索引**（各模块 `:- interface.` 段声明的符号，`exportManager`，
文档构建/删除时同步）；限定名 `M.f` 则查目标模块。
命中类别一致则补标（func/constructor/...）；歧义或未命中保持无类别，
goto def 时对无类别引用**不限类别**匹配（含限定名 `M.f` 跨模块查找）。
find references 按**名字 + 语义元数 + 可见性**过滤（Mercury 名字解析规则）：
限定引用 `M.f` 只保留限定到目标模块的；非限定引用只保留目标模块自身或
import 了目标模块的文档（模块名的显式出现一律保留）。
下文各"可被引用的位置"用 ✅ 标注**已索引**、❌ 标注**尚未索引**的引用位置。

### 5.1 类型声明（`parse_type_defn.m`）
```
:- type T.                                  % 抽象类型
:- type T ---> C1 ; C2 ; ... [where ...].    % 判别联合（DU）
:- type T == U.                             % 类型同义（等价）
:- type T =< Super ---> ... .               % 子类型

:- type T =< Super.                         % 子类型 

:- solver type T ...                        % solver 类型
:- typeclass T where ...                         % where 属性（representation / ground /
                                            %   any / constraint_store / equality /
                                            %   comparison / direct_arg / ...）
```
- DU 的构造函数用 `---` 分隔；构造器可带存在量词约束（`some [...]`) 与 `where` 子句。
- **记录语法**：`pt(x :: float, y :: float)` 与 `pt { x :: float, y :: float }` 等价（`{}` 一层被忽略以允许 `';/2`）。
- `::` 为 inst 注解：`arg_field_name = yes(ctor_field_name(Field))`（`parse_type_defn.m:401-413`）。
- 构造函数 AST：`ctor(Ordinal, MaybeExistConstraints, Functor, Args, Arity, Context)`（`prog_data.m:485-509`）。

**类型名 `T` 可被引用的位置**（定义于本处，引用于；✅ = 已索引进 `typeReference`）：
- ✅ 其它类型声明的体中：等价 `type T2 == T` 的右侧 `U`、子类型 `type T2 =< T` 的 `Super`、
  DU 构造子参数类型（递归，如 `c2(list(string))` 里的 `list`/`string`）；
- ✅ `pred` / `func` 声明的参数类型与返回类型（§5.4）：裸 `Type`、`Type :: Inst` /
  `Type >> Mode` 的类型部分、返回 `(R :: T)`；参数化类型的参数也递归索引（`list(int)`）；
- ✅ `instance C(T1, ..., Tn)` 的类型位置、typeclass 方法签名（§5.5、§11）；
- ✅ inst 声明 `inst I for T/Arity` 的 `Type` 位置（§5.2）——按 `Type/Arity` 写法带
  `semanticArity`（如 `for diet/1` 里 `diet` 显示与匹配为 `diet/1`）；
- ✅ `:- mutable(Var, T, ...)` 的类型位置（§5.7）；
- ✅ 项层类型限定：有类型项 `X :: T`、显式限定 `X : T`（§9.1）；
- ❌ `where` 属性体内的类型（`representation = ...` 等，需先区分属性关键字与值）；
- ❌ `pragma foreign_type`（§14）；
- ❌ 类型类约束位置（§5.5）；`with_type(T, X)` 本 parser 不支持（clause 体语法报错）。

**构造子 `C`**（DU / `=< Super ---> ...` 里的 `C1 ; C2`）：
- 定义位置标为 `constructor`（不是 `type`），与类型名同类目区分地进 `definition`
  （大纲显示为 EnumMember，类型名为 Struct）；构造子参数仍按类型引用索引；
- 引用位置：任意数据项/模式位置（子句头与体中的 functor，§9.1）——与谓词/函数调用**同形**，
  一个 functor 是构造子还是调用，由类型/模式检查在 linker 之后判定，解析树层无法区分
  （体中使用为无标签 functor 引用，goto def 按名字+语义元数命中 `constructor` 定义）；
- inst 体内部：`bound(... ; C(Inst, ...))`（§5.2）；
- 其它类型的 DU 体中（嵌套引用）。

### 5.2 实例（inst）声明（`parse_inst_mode_defn.m`、`parse_inst_mode_name.m`）
```
:- inst I == inst_expr.                  % 等价定义
:- inst I ---> f(...) ; g(...) .         % 等价于 I == bound(f(...); g(...))
:- inst I for Type/Arity == ... .        % 绑定到某类型（'for' 关键字）
```
inst 体关键字：`free`、`ground`、`clobbered`、`mostly_clobbered`、`any`、`unique_any`、
`mostly_unique_any`、`clobbered_any`、`not_reached`、`unique`、`mostly_unique`、`bound(...)`、
`is` / `=<`、`bound_unique`（向后兼容）。

**inst 名 `I` 可被引用的位置**（定义于本处，引用于；✅ = 已索引进 `instReference`）：
- ✅ `pred` / `func` 参数的参数化模式：`Type :: in(I)`、`Type >> in(I)` 的 inst 参数
  （§5.4，如 `in(node)` 的 `node`）——注意 `in` 是内置 mode，标 `mode` 但不进
  `modeReference`（见 §5.3）；
- ✅ mode 声明体：`mode M == I >> J` 的 `InstA` / `InstB` 位置（§5.3，跳过高阶
  `pred(...)`/`func(...)` 头）；
- 内置 inst（`ground`/`any`/`free`/`unique`/`mostly_unique`/`mostly_uniq`/`clobbered`/
  `mostly_clobbered`/`clobbered_any`/`unique_any`/`mostly_unique_any`/`not_reached`/
  `bound_unique`）标 `inst` 但**不进** `instReference`；
  （标 `mode`，进 `modeReference`，见 §5.3），不进 `instReference`；
- ❌ 其它 inst 体内部：`bound(... ; f(I, J))`、等价 `inst I2 == I`、受限 `=<`；
- ❌ 高阶模式的 inst 位置：`pred(I1, I2) is Det` / `func(...) is Det`（§7）。

跳转定义与查找引用已支持 inst：inst 引用 goto def 按类别只命中 inst 定义
（同名同元数的 type 定义不混入）；从 inst 定义查找引用只返回 `instReference` 中的位置。

### 5.3 模式（mode）声明（`parse_inst_mode_defn.m`、`parse_inst_mode_name.m`）
```
:- mode M == InstA >> InstB.             % 从 InstA 到 InstB 的模式
:- mode M(...) == ... .                   % 带参模式
```
核心 `>>` 语法：`from_to_mode(InstA, InstB)`（`parse_inst_mode_name.m:151-163`）。
高阶模式用 `pred(...)` / `func(...) is Det`（`is` 关键字）。

**mode 名 `M` 可被引用的位置**（定义于本处，引用于；✅ = 已索引进 `modeReference`）：
- ✅ `pred` / `func` 声明的参数模式：`Type :: M` / `Type >> M` 的右侧整体（§5.4）——
  含裸 mode（`T :: my_mode`）与参数化模式（`T :: in(I)` 的 `in`），
  其 inst 参数另进 `instReference`，见 §5.2；
- 内置模式（`in`/`out`/`di`/`uo`/`ui`/`muo`）标 `mode` 但**不进** `modeReference`；
- ❌ clause 级模式限定（如 `p(X::in) :- ...` 的 head 注解）；
- ❌ `pragma mode` / `pragma` 相关指令中引用模式名（§14）；
- ❌ 其它 mode 体内部（参数化 mode `m(I)` 的引用位置）。

跳转定义与查找引用已支持 mode：mode 引用 goto def 按类别只命中 mode 定义；
从 mode 定义查找引用只返回 `modeReference` 中的位置。

### 5.4 谓词 / 函数声明（`parse_item.m:1023-1106`）
```
:- pred P(Arg1, Arg2, ...) [is Detism].
:- func F(Arg1, ...) = RetType [is Detism].
:- pred P(A1 :: in, A2 :: out) is semidet.    % '::' 为 inst 注解
:- func F(A1) = (R :: out )is det.
```
- 参数模式支持 `Type`、`Type >> Mode`、`Type :: Inst`（`parse_type_name.m`）。
- 函数返回用 `=` 分隔。
- 确定性后缀 `is Detism`（`parse_determinism_suffix`，`parse_item.m:1039`）。
- 量化/约束/purity 前缀（`parse_item.m:275-293`）：`some`/`all`、`=>`/`<=`、`impure`/`semipure`。
  声明级 purity 前缀（`impure pred ...`，解析为 `impure/1` 包裹）是**关键字**：visitor
  跳过词头（不进索引），声明本体照常索引（✅）。

**谓词名 `P` 可被引用的位置**（定义于本处，引用于；✅ = 已索引进 `reference`）：
- 子句定义头（定义位置本身，§4，进 `definition`）；
- ✅ 子句体目标：`p(X, Y)` 调用目标 → `call_expr`（§9.2）；
- ✅ 高阶引用：闭包 `p/3`（`Name/Arity` 形式，标 `pred`、记 `semanticArity = Arity`；
  `/` 本体不进索引）、`predicate(T1, ...)` 高阶类型（同 `pred(...)` 处理）、`apply`
  调用目标（§12）；
- ✅ `:- initialise p/2.` / `:- finalise p/2.`：`PredName` 是 pred 引用（§5.7）；
- ✅ pragma 指令（§14）：`inline`/`no_inline`/`obsolete`/`obsolete_proc`/`promise_pure`/
  `foreign_export` 等的 `Name/Arity` 参数（标 `pred`）；`foreign_proc` 的过程头——
  pred 形式 `p(X::in, Y::out)` 标 `pred`，函数形式 `init(N::in, X::in) = (VA::out)`
  解包 `=/2` 取函数头标 `func`；`foreign_export_enum` 的枚举构造子 `color/0`
  进 `reference` 但不标 `pred`；
- ✅ typeclass 方法签名（§5.5）与 instance 方法实现（§11.2）（进 `declaration`）；
- ✅ `:- promise <Goal>` 断言的 goal 内（§5.6）。

**函数名 `F` 可被引用的位置**（定义于本处，引用于）：
- ✅ 表达式/数据项中的调用 `f(X)`（§9.1、§9.3——解析树层无独立 expr，函数调用就是 functor）；
- 子句定义头 `f(A) = R :- ...`（定义位置本身）；
- ✅ 高阶引用：`F = f/1`（`Name/Arity` 形式，同闭包）、`apply`、`function(...) = ...`
  高阶类型（同 `func(...)` 处理）、`func(...) is Det` 模式（§12）；
- ✅ pragma 指令（同谓词，§14）；
- ✅ typeclass / instance 方法（§11）。

pred / func 的子句体引用走 `reference` 索引（✅）；类型类方法签名里的 pred/func
经 `:- pred/func` 声明路径索引（✅，进 `declaration`）。

### 5.5 类型类 / 实例（`parse_class.m`，见第 11 节）
```
:- typeclass TC(T) where [ ... ].        % 类型类声明（方法签名在 where 块）
:- instance TC(T) where [ ... ].         % 实例声明（方法实现在 where 块）
```
- 语法细节见 §11.1–11.3。

**类型类名 `TC` 可被引用的位置**（定义于本处，引用于）：
- 类型类约束：`pred` / `func` / typeclass 声明中 `T <= TC(...)` 的约束位置（§11.3）；
- typeclass 声明的超类位置：`typeclass TC(T) <= TC2(T, ...)`（§11.1）；
- instance 声明头：`instance TC(T1, ..., Tn)`（§11.2）；
- pragma `type_spec`（§14）。

❌ 以上 typeclass 引用位置**均尚未索引**（无 typeclassReference）。注：带约束的声明
`:- pred ... is det <= TC(T).` 本身已能被索引（visitor 解包 `<=/2` 约束后正常声明处理），
只是约束里的 `TC` 未作为引用记录。

**instance 声明引用的符号**：类型类名 `TC`、被实例化的类型 `T1..Tn`（§5.1）、
`where` 块方法实现里引用的 pred / func / typeclass 方法名。

### 5.6 断言（assertion）
```
:- promise <Goal>.                       % 承诺（正确性断言）
```
其余 `require_*` 以 pragma 形式存在（见第 14 节）。`expect` 是运行期断言（在 `require` 库），不属解析树级声明。

**可被引用的位置**：`<Goal>` 是普通目标，可引用任意 pred / func / mutable（§9.2）；
断言引用的符号必须与对应声明处一致（编译期校验）。

### 5.7 可变状态与初始化
```
:- mutable(VarName, Type, Inst, InitValue, Attributes).
:- initialise  PredName.
:- finalise    PredName.
```
（`parse_mutable.m:38`，AST：`item_mutable_info`，`prog_item.m:294-334`）

**可变变量 `VarName` 可被引用的位置**（定义于本处，引用于）：
- 子句体中的读取 `Var` 与写入 `Var := X`（§9.2 合一/赋值目标）；
- 状态变量语法糖：`!Var`、`!.Var`（读）、`!:Var`（写）（§9.1）；
- 自动生成的访问谓词 `get_VarName/N`、`set_VarName/N` 可像普通 pred 一样被引用；
- `:- initialise` / `:- finalise` 引用的 `PredName` 必须是本模块中声明的 pred（§5.4）。

`:- mutable` 的类型位置已索引（✅ `typeReference`）；VarName 本体的体引用
（`!Var` 等）走 variable 的 clause 级 `varMap` 索引（✅）。

---

## 6. 类型系统

依据 `doc/mercury_reference_manual.texi`（Types 章节，行 2813+）。

- **强类型 + 参数多态**：类型形如 `list(T)`、`map(K, V)`；类型变量以大写字母开头。
- **判别联合（DU）**：`type T ---> C1 ; C2 ; ...`，构造器可带字段（普通或记录语法）。
- **类型同义**：`type T == U`（透明同义，不引入新类型）。
- **抽象类型**：`type T.`（实现区可见构造细节，接口区只暴露抽象类型）。
- **子类型 / 存在类型**：`type T =< Super ---> ...`；存在量词项 `some [X] f(X)`。
- **用户自定义相等/比较**：可覆盖 `=` 与比较谓词（见参考手册“User-defined equality and comparison”）。
- 类型检查器在 `compiler/check_typeclass.m`、`compiler/check_type_inst_mode_defns.m` 等处实现。

类型本身被直接解析为 `mer_type`（`prog_type`），无中间 `type_expr` AST。

---

## 7. 实例化与模式（Insts & Modes）

依据 `doc/mercury_reference_manual.texi`（Modes 章节，行 4066-4846）。

**模式（mode）**是参数“初始实例化状态 → 最终实例化状态”的映射。实例化用**实例化树
（instantiatedness tree）**描述：给类型树的每个 or-node 赋 `free` 或 `bound`，约束是
“free 节点的所有后代必须也是 free”。

```mercury
:- inst listskel == bound([] ; [free | listskel]).   % 已知骨架、元素为互异自由变量
:- inst maybeskel ---> no ; yes(free).               % 等价于 bound(no ; yes(free))
:- inst maybeskel for maybe/1 ---> no ; yes(free).   % 限定用于 maybe/1
```

模式用 `>>` 表示 from→to 映射：

```mercury
:- mode in  == ground >> ground.     % 输入
:- mode out == free   >> ground.     % 输出
:- mode in(Inst)  == Inst >> Inst.   % 参数化
:- mode out(Inst) == free >> Inst.

:- inst request for operation/0
    ---> lookup(ground, free) ; set(ground, ground).
:- mode create_request  == free   >> request.   % 构造请求
:- mode satisfy_request == request >> ground.    % 满足请求
```

- `inst` / `mode` 均可参数化（如 `listskel(Inst)` for `list/1`）。
- 当前实现对部分实例化数据结构（同时含函数符号与自由变量的项，如 `f(a, b, X)`）支持有限
  （因模式系统缺乏别名追踪），见 `LIMITATIONS.md`。
- 高阶 inst/mode：`pred(...)` / `func(...) is Det`（约束高阶参数的模式与确定性）。

---

## 8. 确定性（Determinism）

依据 `doc/mercury_reference_manual.texi`（Determinism 章节，行 4847-5012）与
`compiler/prog_detism.m`、`compiler/prog_data.m:1707`。

对某个谓词/函数的某个模式，根据“能成功多少次”与“是否可能在产生首个解前失败”分类，共 **8 类**
（`prog_data.m:1707`）：`det`、`semidet`、`multi`、`nondet`、`cc_multi`、`cc_nondet`、
`erroneous`、`failure`。

| 能否失败？ \ 最多解数 | 0 | 1 | >1 |
|---|---|---|---|
| 否（总能产生至少一解） | `erroneous` | `det` | `multi` |
| 是（可能产生零解） | `failure` | `semidet` | `nondet` |

- `cc_multi` / `cc_nondet`（committed-choice）为非回朔的多解/零或多解模式（用于约束/并发）。
- `erroneous`：调用不可能正常返回（如 `require.error/1`、`exception.throw/1`）。
- `failure`：调用必然失败（如 `q :- fail`）。

**确定性偏序格**（越高编译器知道的求解信息越多）：

```
            erroneous
             /     \
         failure   det
            \     /   \
            semidet  multi
                \     /
                 nondet
```

`det` / `multi` 断言“对每个输入值，至少存在一个使谓词成立（或函数项等于结果项）的输出值”；
`det` / `semidet` 断言“至多一个”。这些称为 **mode-determinism 断言**，可启用激进优化
（如删除无输出的目标）。确定性由 `compiler/det_analysis.m` 从子目标组合推断，组合规则表在
`compiler/prog_detism.m`（`det_conjunction_detism`、`det_switch_detism`、`det_negation_det` 等）。

---

## 9. 项、目标与表达式

### 9.1 项（term）语法（`library/term.m`，见 §2.7 字面量 + 以下构造）

| 语法 | 例子 | 底层 AST | 源码 |
|------|------|----------|------|
| 变量 | `X` | `variable(Var, Ctx)` | term.m:49 |
| functor 项 | `f(a, b)` | `functor(atom("f"), [a,b], Ctx)` | parse_goal.m:87 |
| 列表 | `[1,2,3]` | `functor(atom("[|]"), ...)` | parse_dcg_goal.m:147 |
| 空列表 | `[]` | `functor(atom("[]"), [], Ctx)` | — |
| 元组 | `{a, b}` | `functor(atom("{}"), [a,b], Ctx)`（类型检查后转 `tuple_cons(2)`） | prog_data.m:111 |
| 中缀/前缀/后缀 | `A + B`, `-X` | `functor(atom("+"), [A,B], Ctx)` | ops.m |
| 注解项 | `Term @ Ann` | `functor(atom("@"), [Term, Ann], Ctx)` | ops.m:631 |
| 有类型项 | `X :: T` | `functor(atom("::"), [X, T], Ctx)` | add_clause.m:588 |
| 存在量词项 | `some [X] Goal` | `quant_expr(quant_some, ..., [X], Goal)` | parse_goal.m:692 |
| 通用量词项 | `all [X] Goal` | `quant_expr(quant_all, ...)` | parse_goal.m:706 |
| 状态变量 | `!SV` / `!.SV` / `!:SV` | `functor(atom("!"/"!."/"!:"), [variable(SV)])` | parse_vars.m:191 |

**关键事实**：解析树层**没有独立的 `expr` 类型**——算术/比较/函数式表达式就是带操作符的 term。
函数调用在表达式中即 `functor(atom("f"), [args])`；在目标语境下经 `try_parse_sym_name_and_args`
识别为 `call_expr`。

### 9.2 目标（goal）语法（`parse_goal.m`，入口 `parse_goal`，`parse_goal.m:78-107`）

内置目标种类（由 `string_goal_kind` 分发，`parse_goal.m:333-397`）：

| 语法 | functor | AST 构造 | 源码 |
|------|---------|----------|------|
| 合取 | `,` | `conj_expr` | parse_goal.m:762 |
| 并行合取 | `&` | `par_conj_expr` | parse_goal.m:790 |
| 析取 | `;` | `disj_expr` | parse_goal.m:915 |
| if-then-else | `->`/`;` 或 `if/then/else` | `if_then_else_expr` | parse_goal.m:846,970 |
| 否定 | `not` / `\+` | `not_expr` | parse_goal.m:667 |
| 存在量化 | `some [X] G` | `quant_expr(quant_some,...)` | parse_goal.m:692 |
| 通用量化 | `all [X] G` | `quant_expr(quant_all,...)` | parse_goal.m:706 |
| 蕴含/等价 | `<=`/`=>`/`<=>` | `implies_expr`/`equivalent_expr` | parse_goal.m:1199 |
| trace | `trace [...]` | `trace_expr` | parse_goal.m:1241 |
| atomic | `atomic [...]` | `atomic_expr` | parse_goal.m:1281 |
| try/catch | `catch`/`catch_any` | `try_expr` | parse_goal.m |
| true / fail | `true`/`fail` | `true_expr`/`fail_expr` | parse_goal.m |
| 合一 | `=` | `unify_expr(..., pure)` | parse_goal.m:1660 |

调用目标：`p(X, Y)` → `call_expr(Context, unqualified("p"), [X,Y], pure)`；对自由变量/字面量的
调用退化为 `call_expr(.., "call", [Term])`。

goal 级 purity 前缀 `impure Goal` / `semipure Goal` / `pure Goal`（解析为 `impure/1` 等
单参包裹）是**关键字**：visitor 跳过词头（不进 `reference`），目标本体照常索引（✅）。

### 9.3 表达式（不独立成类）
- `3 + 4 * X` → `functor(atom("+"), [3, functor(atom("*"), [4, X])])`。
- `f(A) = g(B)` 在目标层是 `unify_expr`；在项层是 `functor(atom("="), [..])`。
- 比较/算术/逻辑操作符的优先级与结合性全部由 `library/ops.m` 管理。
- if-then-else 表达式：`if C then T else E`（项层 `functor(atom("if"), [C,T,E])`，由 `superhomogeneous.m` 处理）。

---

## 10. 合一（Unification）

| 语法 | 类别 | AST | 说明 |
|------|------|-----|------|
| `X = Y` | 合一（目标） | `unify_expr(Ctx, X, Y, pure)` | parse_goal.m:1660 |
| `X \= Y` | 不可合一 | 普通谓词调用 `call_expr(.., "\=", [X,Y])` | 无专门 goal 构造 |
| `X := Y` | 破坏式赋值 | 普通调用 `call_expr(.., ":=", [X,Y])` | ops.m:628（prio 850） |
| `A <= B` / `A => B` / `A <=> B` | 蕴含/等价（目标） | `implies_expr`/`equivalent_expr` | parse_goal.m:1199 |

合一语义：把两个项统一；函数式 `=` 同时断言方程两侧在声明式语义上相等（见第 15 节）。
`X = Y at bar` 中的 `at` 由项读取器以 functor 形式保留（`at` 注解）。

---

## 11. 类型类与约束多态

依据 `parse_class.m` 与 `doc/mercury_reference_manual.texi`（Type classes 章节）。

### 11.1 类型类声明
```
:- typeclass TCName(T1, ..., Tn) [<= (SuperConstraints)] [where [ Methods ]].
```
- 至少 1 个类型参数，且参数互异（`parse_class.m:400-443`，否则报 “require at least one class parameter”）。
- `<=` 后为超类约束 + 函数依赖（同一括号内，函数依赖用 `->` 分隔两侧逗号分隔的类型变量）。
- `where [...]` 方法签名**只能是** `pred` / `func` / `mode` 声明（`parse_item.m:453-490`）。
- 例：
  ```mercury
  :- typeclass eq(T) <= (ord(T)) where [
      pred equal(T, T).
      mode equal(in, in) is semidet,
      func hash(T) = int
  ].
  :- typeclass convert(A, B) <= (A -> B, B -> A) where [
      func to(A) = B, func from(B) = A
  ].
  ```

### 11.2 实例声明
```
:- instance TCName(Type1, ..., Typen) [<= Constraints] [where [ MethodInsts ]].
```
- `<=` 分支为“派生实例”（derived instance），约束须为简单约束（`parse_instance_constraints`）。
- 方法实例：`pred p/N is Name`（重定向）或直接给出子句（`parse_class.m:690-824`）。
- 例：
  ```mercury
  :- instance eq(int) where [
      pred equal/2 is int_equal,
      func hash/1 = int_hash
  ].
  :- instance eq(list(T)) <= (eq(T)) where [
      ( equal(Xs, Ys) :- ... )
  ].
  ```

### 11.3 约束语法（约束多态）
```
:- pred show(T) <= showable(T).            % 全称约束（调用方需保证）
:- func map(F, A) = B => (func(F) = G, some [C] container(G, C)).  % 存在约束
```
- `<=` ⇒ 全称约束（`quant_type_univ`）；`=>` ⇒ 存在约束（`quant_type_exist`）（`parse_item.m:282-287`）。
- AST：`prog_constraint` = `constraint(class_name, list(mer_type))`（`prog_data.m:1154`）；
  声明上的约束对用 `univ_exist_constraints`（`prog_data.m:1160`）。
- **本版本不支持 `default` 方法**（`class_decl` 仅含 `pred`/`func`/`mode`，见 §13 核查表）。

---

## 12. 高阶（Higher-order）

- **lambda 表达式**：`pred(X::in) is det :- G` / `func(X) = Y :- G`（lambda 头用
  `lambda_head` 类型，`superhomogeneous_lambda.m:676`，转 HLDS 时再处理）。
- **闭包与柯里化**：函数/谓词可部分应用形成闭包项。
- **高阶模式**：`pred(...)` / `func(...) is Det` 用于约束高阶参数的模式与确定性
  （`parse_inst_mode_name.m:200-237`）。
- 高阶谓词如 `map/3`、`foldl/4` 在 `library/` 中定义。

---

## 13. DCG 语法糖

语法（`parse_dcg_goal.m`，入口 `parse_dcg_clause`，`parse_dcg_goal.m:41-113`）：

```mercury
Head --> Body.
```

展开规则：
1. `parse_dcg_goal(Body)` 把 Body 展开为带 DCG 状态变量 `!DCG` 的普通 goal；
2. 把 `DCGVar0, DCGVar` 追加到 Head 参数末尾，生成普通谓词子句
   `item_clause_info(pf_predicate, SymName, ArgTerms ++ [In, Out], ...)`。

DCG 体内的特殊目标（`dcg_goal_kind`，`parse_dcg_goal.m:177-245`）：

| 语法 | 处理 |
|------|------|
| `nt(A)` | 非终结符调用，追加 `!DCG` 输入/输出变量 |
| `{ G }` | 普通 Mercury 目标（先把 `{}` 元组还原为合取，再 `parse_goal`） |
| `[a, b]` / `[]` | 与 DCG 变量做列表合一（消费输入） |
| `=(T)` | 与 DCG **输入**变量合一 |
| `:=(T)` | 与 DCG **输出**变量合一（忽略输入） |
| `^ field := T` | 字段更新，表示为 `call_expr(.., ":=", [^field_list, T])` |
| `,` `&` `;` `some` `all` `not` `if/then/else` | 同普通 goal，递归展开 |

---

## 14. Pragma（编译器指令）

入口 `parse_pragma.m` → `parse_named_pragma`（派发，`parse_pragma.m:75-304`）。
完整清单（按段归类）：

**声明段（item_decl_pragma，`prog_item_pragma.m:37-48`）**：
`obsolete`、`obsolete_proc`、`format_call`、`type_spec_constrained_preds`、
`type_spec`、`input_mode_spec`、`oisu`、`termination_info`、`termination2_info`、
`structure_sharing`、`structure_reuse`。

**实现段（item_impl_pragma，`prog_item_pragma.m:50-58`）**：
`foreign_decl`、`foreign_code`、`foreign_export`、`external_pred`/`external_func`、
`fact_table`、`memo`/`loop_check`/`minimal_model`（tabling）、`require_tail_recursion`、
`require_feature_set`。

**标记类 pragma（`parse_pragma.m:177-216`）**：
`terminates`/`does_not_terminate`/`check_termination`、`inline`/`no_inline`/
`consider_used`/`mode_check_clauses`/`no_determinism_warning`/`promise_pure`/
`promise_semipure`/`promise_equivalent_clauses`/`require_switch_arms_in_type_order`/
`disable_non_tail_recursion_reports`。

**Foreign 类 pragma（`parse_pragma_foreign.m`）**：
```mercury
:- pragma foreign_type("C", foo, "struct foo *").
:- pragma foreign_enum("C", color, [red-"RED", green-"GREEN"]).
:- pragma foreign_proc("C", foo(X::in, Y::out), [will_not_call_mercury], "Y = ...;").
:- pragma foreign_export("C", foo/2, "c_foo").
:- pragma foreign_decl("C", [local], "code").
:- pragma foreign_code("C", "code").
:- pragma foreign_import_module("C", module).
```

**编译器生成（item_generated_pragma，`prog_item_pragma.m:60-64`）**：
`unused_args`、`exceptions`、`trailing_info`、`mm_tabling_info`。

---

## 15. 形式语义

依据 `doc/mercury_reference_manual.texi`（Formal semantics 章节，行 8962-9120）。

### 15.1 声明式语义（declarative semantics）
一个合法的 Mercury 程序对应一个**谓词演算理论**：
- **语言**由程序中的类型声明规定；
- **公理**由程序所有谓词子句的 completion（完备化）给出，加上标准的等式公理（并扩展以所有函数方程的 completion），
  加上 mode-determinism 断言对应的公理，加上库谓词/函数的语义公理。

Mercury 实现必须**可靠（sound）**：它们算出的答案必须在理论的每个模型中都为真。实现不要求**完全（complete）**
（可能因资源限制而无法在有限时间算出答案），但须满足最低完全性要求。

### 15.2 操作式语义（operational semantics）
存在两种标准化的操作式语义：

1. **严格顺序语义（strict sequential）**：
   - 从 `main/2`（前接模块初始化目标、后接收尾目标）开始，自顶向下用 **SLDNF 求解**（或等价物）执行。
   - 函数调用、合取、析取均按**深度优先、从左到右**执行。
   - 合取与函数调用按模式做“**最小重排**（minimal reordering）”：选择第一个模式正确的子目标执行，再选下一个，依此类推；子目标被重排而非拆分交织。
   - 函数应用是**严格（strict）**的，非惰性；谓词调用也是严格的（即使会死循环、为 `erroneous`、或 `det` 且无输出也会执行）。
   - 所有实现**必须**支持此语义，以保证跨实现的程序可移植性。

2. **严格交换语义（strict commutative）**：
   - 与严格顺序语义等价，但不要求从左到右；函数调用、合取、析取可以任意顺序甚至交织执行，且每次进入同一目标时顺序可能不同。
   - **默认语义**即严格交换语义；`--no-reorder-conj` + `--no-reorder-disj` 可强制严格顺序语义。

实现还可提供**实现定义的操作式语义**，只要其完全性不低于严格交换语义。Melbourne Mercury 提供八种操作式语义
（通过 `--no-reorder-conj` / `--no-reorder-disj` / `--no-fully-strict` 等组合选择）。

> 这种“声明式语义 + 多种操作式语义”的折中，让 Mercury 既能用于追求可移植性的严格顺序编程，
> 也能用于追求效率的激进重排/并行实现，只要后者对声明式语义可靠且满足最低完全性。

---

## 16. 源码索引

| 主题 | 关键文件:行 |
|------|------------|
| 顶层 AST `item` | `compiler/prog_item.m:83-104` |
| 目标 AST `goal` | `compiler/prog_item.m:622-775` |
| 项 AST `term(T)` | `library/term.m:43-70` |
| 确定性 8 类 | `compiler/prog_data.m:1707`；`compiler/prog_detism.m` |
| 确定性组合表 | `compiler/prog_detism.m:27-60` |
| 解析派发 | `compiler/parse_item.m:148-340` |
| 类型定义 | `compiler/parse_type_defn.m` |
| inst/mode 定义 | `compiler/parse_inst_mode_defn.m`、`parse_inst_mode_name.m` |
| 类型类/实例 | `compiler/parse_class.m` |
| 目标解析 | `compiler/parse_goal.m`、`parse_goal_util.m`、`parse_dcg_goal.m` |
| 变量/状态变量 | `compiler/parse_vars.m` |
| Pragma | `compiler/parse_pragma.m`、`parse_pragma_foreign.m` |
| 可变状态 | `compiler/parse_mutable.m` |
| 模块/区段 | `compiler/parse_module.m`、`compiler/prog_parse_tree.m` |
| 操作符表 | `library/ops.m` |
| 项读取器（操作符声明/读期注解） | `library/mercury_term_parser.m` |
| 形式语义、模式、确定性、类型 | `doc/mercury_reference_manual.texi`（行 8962 / 4066 / 4847 / 2813） |

### 本版本已确认“不支持”的特性（来自源码核查）
| 特性 | 结论 | 证据 |
|------|------|------|
| `:- module foo, [attr].`（模块属性） | 不支持 | `parse_module_marker` 仅接受单模块名 |
| `import_module M only [...] / except [...]` | 不支持 | `parse_incl_imp_use_items` 仅解析模块名列表 |
| 类型类 `default` 方法 | 不支持 | `class_decl` 仅含 `pred`/`func`/`mode` |
| 独立的 `:- enum` 声明 | 不存在 | 枚举用 `abstract type` + `foreign_enum` 或普通 DU 表达 |

---

*文档基于仓库当前源码（Mercury 编译器，版本见 `VERSION`）分析整理。如需进一步展开某一子项
（如 `trace_expr`/`atomic_expr`/`try_expr` 的参数字段语义、lambda 转 HLDS 细节、或 `cons_id`
在类型检查后的富表示），可继续深入分析对应模块。*
