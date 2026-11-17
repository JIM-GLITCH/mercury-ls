import { Hover, HoverParams, MarkupContent } from 'vscode-languageserver'
import { semanticArityOf } from './utils'
import { moduleQualifiedName, search, termRange } from './term'
import { URI } from 'vscode-uri'
import { merTypeToString, uniqSig, keyOf, type FuncInfo, type MerType } from './document-type'

import type { MercuryServices } from './services'

export async function HoverProvider(services: MercuryServices, params:HoverParams) {
    let pos = params.position;
    let uri = params.textDocument.uri;
    let doc = services.documents.getOrCreateDocument(URI.parse(uri));
    let  term  = search(doc.parseResult.value,pos)
    if(!term)
        return

    // func/pred 的签名：推断过的项只信 inferred.sig——消歧失败（sig 缺失）
    // 时不回退本地/导出索引首个匹配，否则 ++ 这类多模块重名符号会把
    // list.++ 误显成 string.++。未推断的项（声明处、未打开文档）才走兜底
    const inferredInfo = doc.visitResult?.inferred.get(term)
    const sigFi = (term.semanticType === 'func' || term.semanticType === 'pred')
        ? inferredInfo
            ? inferredInfo.sig
            : uniqSig(doc.visitResult?.sigAlts.get(term.name)
                ?.filter(f => f.arity === term.semanticArity))
                ?? uniqSig(services.exportManager.lookupSigAlts(term.name, term.semanticArity, term.semanticArity))
        : undefined

    // 符号的限定显示名：能解析出定义模块就带 module 前缀（m.add / io.error）
    const entityModule = (): string | undefined => {
        switch (term.semanticType) {
            case 'func':
            case 'pred':
                return sigFi?.module
            case 'type': {
                if (term.qualified) return term.qualified
                const arity = term.semanticArity ?? term.arity
                const local = doc.visitResult?.types.get(term.name)
                    ?.filter(ti => ti.ctor.arity === arity).at(-1)
                if (local) return local.ctor.module
                return services.exportManager.lookupType({ name: term.name, arity })?.ctor.module
            }
            case 'constructor': {
                if (term.qualified) return term.qualified
                // 构造子结果类型的 ctor.module = 所属类型模块（推断已写入时最准）
                const t = doc.visitResult?.inferred.get(term)?.type
                if (t?.kind === 'ctor') return t.ctor.module
                for (const ti of [...(doc.visitResult?.types.values() ?? [])].flat()) {
                    const ci = ti.constructors.find(c => c.ctor === term.name && c.arity === term.arity)
                    if (ci) return ci.typeCtor.module
                }
                return undefined
            }
            default:
                return term.qualified
        }
    }
    const qname = entityModule()
    const dispName = qname ? `${qname}.${term.name}` : term.name

    let header: string
    if(term.semanticType){
        switch (term.semanticType){
            case 'func':
            case 'pred':
            case 'type':
            case "constructor":
                header = `(${term.semanticType}) ${dispName}/${semanticArityOf(term)}`
                break ;
            case "inst":
            case "mode":
            case "typeclass":
            case "instance":
            case "pragma":
            case "operator":
                header = `(${term.semanticType}) ${term.name}/${semanticArityOf(term)}`
                break ;
            case 'module':
            case "variable":
            case "mutable":
            case "determinism":
                header = `(${term.semanticType}) ${term.name}`
                break ;
            default:
                header = `(${term.semanticType}) ${term.name}`
        }
    }
    else{
        switch (term.syntaxType) {
            case 'string':
            case 'variable':
            case 'integer':
            case 'float':
            case 'implementation_defined':
                header = term.name;
                break ;
            case 'atom':
                header = `${term.name}/${semanticArityOf(term)}`;
                break ;
            default :
                header = term.name;
                break;
        }
    }

    // 类型展示：func/pred 按行显示「类型签名 + 每个 mode 声明一行」；
    // 其余项显示推断类型（`type ...`）；module（限定名前缀）不显示类型行
    let typeStr: string | undefined
    if (term.semanticType !== 'module') {
        if (term.semanticType === 'func' || term.semanticType === 'pred') {
            const fi = sigFi
            if (fi) {
                const sigName = fi.module ? `${fi.module}.${fi.name}` : fi.name
                const args = fi.argTypes.map(merTypeToString).join(', ')
                const lines = [term.semanticType === 'func'
                    ? `type ${sigName}(${args}) = ${fi.resultType ? merTypeToString(fi.resultType) : '?'}`
                    : `type ${sigName}(${args})`]
                const localMod = doc.visitResult?.module ? moduleQualifiedName(doc.visitResult.module) : undefined
                const isLocalSig = !fi.module || fi.module === localMod
                const modeLines = isLocalSig
                    ? doc.visitResult?.modeSigs.get(keyOf(term.name, term.semanticArity)) ?? []
                    : []
                if (modeLines.length > 0) {
                    for (const ml of modeLines) {
                        lines.push(`mode ${ml}`)
                    }
                } else if (fi.modes?.length) {
                    // 外部签名（或本地无 modeSigs 展示串）：从结构化 modes 逐条渲染，
                    // 与 modeSigs 的「每个 mode 声明一行」格式对齐（含 is det）
                    for (const m of fi.modes) {
                        const argModes = m.argModeRefs.map(r => r.name).join(', ')
                        const det = m.det ? ` is ${m.det}` : ''
                        lines.push(term.semanticType === 'func'
                            ? `mode ${sigName}(${argModes}) = (${m.resultModeRef ? m.resultModeRef.name : 'out'})${det}`
                            : `mode ${sigName}(${argModes})${det}`)
                    }
                } else if (fi.argModeRefs) {
                    // 兜底：从结构化 argModeRefs 渲染一行
                    //（未注解参数在 record 时已默认填充 in/out）
                    const refName = (r: { kind: string; name: string }) => r.name
                    const argModes = fi.argModeRefs.map(refName).join(', ')
                    lines.push(term.semanticType === 'func'
                        ? `mode ${sigName}(${argModes}) = (${fi.resultModeRef ? refName(fi.resultModeRef) : 'out'})`
                        : `mode ${sigName}(${argModes})`)
                }
                typeStr = lines.join('\n')
            }
        }
        // constructor：type 行显示构造子签名（Mercury 里构造子即函数：参数 = 结果类型）
        else if (term.semanticType === 'constructor') {
            for (const ti of [...(doc.visitResult?.types.values() ?? [])].flat()) {
                const ci = ti.constructors.find(c => c.ctor === term.name && c.arity === term.arity)
                if (ci) {
                    const args = ci.argTypes.map(merTypeToString).join(', ')
                    const ctorName = ci.typeCtor.module ? `${ci.typeCtor.module}.${ci.ctor}` : ci.ctor
                    const head = args ? `${ctorName}(${args})` : ctorName
                    typeStr = `type ${head} = ${merTypeToString(ci.resultType)}`
                    break
                }
            }
        }
        if (!typeStr) {
            const inferred = doc.visitResult?.inferred.get(term)
            if (inferred?.type) {
                const lines = [`type ${merTypeToString(inferred.type)}`]
                typeStr = lines.join('\n')
            }
        }
    }

    const code = [header, typeStr].filter(s => s !== undefined).join('\n')

    return {
        contents:{
            kind:"markdown",
            value:[
                '```mercury',
                code,
                '```'
            ].join('\n')
        } as MarkupContent,
        range:termRange(term)
    } as Hover
}
