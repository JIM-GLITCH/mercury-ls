import { Term, moduleQualifiedName } from './term'

// ===== 模块依赖排序（跨模块推断要求 import 目标先于 importer 的 visit）=====
// 从 parse 树抽头信息，无需完整 visit（visit 后才能拿到 vr.imports，不能用于排序）
export function scanHeader(root: Term): { module?: string; imports: string[] } {
    const imports: string[] = []
    const includes: string[] = []
    let moduleName: string | undefined
    const addNames = (t: Term, out: string[]) => {
        if (t.nameArity === ',/2') {
            addNames(t.args[0], out)
            addNames(t.args[1], out)
            return
        }
        // 嵌套模块名（io.stream_ops）是 './2' 链，t.name='.'；统一走点分名
        out.push(moduleQualifiedName(t))
    }
    const walk = (t: Term) => {
        if (t.nameArity === 'module/1' && t.args.length > 0) {
            moduleName = moduleQualifiedName(t.args[0])
        } else if (t.nameArity === 'import_module/1' && t.args.length > 0) {
            // import_module/use_module 必须写全限定名
            addNames(t.args[0], imports)
        } else if (t.nameArity === 'use_module/1' && t.args.length > 0) {
            addNames(t.args[0], imports)
        } else if (t.nameArity === 'include_module/1' && t.args.length > 0) {
            // include_module 声明子模块，名字相对当前模块（stream_ops → io.stream_ops），
            // 等 walk 完拿到 moduleName 再解析
            addNames(t.args[0], includes)
        }
        for (const a of t.args) walk(a)
    }
    walk(root)
    for (const inc of includes) {
        imports.push(moduleName && inc !== moduleName && !inc.startsWith(moduleName + '.')
            ? moduleName + '.' + inc : inc)
    }
    return { module: moduleName, imports }
}

// 拓扑排序：items 按「import 目标先于 importer」排列。仅对批次内互相可见的依赖边生效；
// 依赖目标不在批次（已构建/外部）则忽略该边。有环（理论上不会发生）则环内保持原相对序。
export function orderByImports<T>(
    items: T[],
    getName: (t: T) => string | undefined,
    getImports: (t: T) => string[],
): T[] {
    const nameToItem = new Map<string, T>()
    for (const it of items) {
        const n = getName(it)
        if (n) nameToItem.set(n, it)
    }
    // 反向邻接：dep → 依赖它的项。旧实现每出队一个节点就全表扫描 items
    // 再对每个 deps.includes(it)，是 O(V·E)；4186 个文档时是千万级操作。
    const dependents = new Map<T, T[]>()
    const indeg = new Map<T, number>()
    for (const it of items) {
        const imps = getImports(it).filter(n => nameToItem.has(n)).map(n => nameToItem.get(n)!)
        indeg.set(it, imps.length)
        for (const d of imps) {
            const arr = dependents.get(d)
            if (arr) arr.push(it)
            else dependents.set(d, [it])
        }
    }
    const order: T[] = []
    const queue: T[] = items.filter(it => indeg.get(it) === 0)
    const seen = new Set<T>()
    for (let qi = 0; qi < queue.length; qi++) {
        const it = queue[qi]
        if (seen.has(it)) continue
        seen.add(it); order.push(it)
        for (const other of dependents.get(it) ?? []) {
            if (seen.has(other)) continue
            const v = indeg.get(other)! - 1
            indeg.set(other, v)
            if (v === 0) queue.push(other)
        }
    }
    for (const it of items) if (!seen.has(it)) order.push(it)  // 环兜底
    return order
}
