import { Hover, HoverParams, MarkupContent } from 'vscode-languageserver'
import { semanticArityOf } from './utils'
import { search, termRange } from './term'
import { URI } from 'vscode-uri'
import { merTypeToString, keyOf, type FuncInfo, type MerType } from './document-type'
import { moduleQualifiedName } from './document-moduleManager'
import type { MercuryServices } from './services'

export async function HoverProvider(services: MercuryServices, params:HoverParams) {
    let pos = params.position;
    let uri = params.textDocument.uri;
    let doc = services.documents.getOrCreateDocument(URI.parse(uri));
    let  term  = search(doc.parseResult.value,pos)
    if(!term)
        return

    // func/pred 的签名（含跨模块导出索引兜底）：头部限定名与 type 行共用
    const sigFi = (term.semanticType === 'func' || term.semanticType === 'pred')
        ? doc.visitResult?.inferred.get(term)?.sig
            ?? doc.visitResult?.funcs.get(keyOf(term.name, term.semanticArity))
            ?? doc.visitResult?.preds.get(keyOf(term.name, term.semanticArity))
            ?? services.exportManager.lookupFunc(term.name, term.semanticArity)
        : undefined

    // 符号的限定显示名：能解析出定义模块就带 module 前缀（m.add / io.error）
    const entityModule = (): string | undefined => {
        switch (term.semanticType) {
            case 'func':
            case 'pred':
                return sigFi?.module
            case 'type': {
                if (term.qualified) return moduleQualifiedName(term.qualified)
                const arity = term.semanticArity ?? term.arity
                const local = doc.visitResult?.types.get(keyOf(term.name, arity))
                if (local) return local.ctor.module
                return services.exportManager.lookupType({ name: term.name, arity })?.ctor.module
            }
            case 'constructor': {
                if (term.qualified) return moduleQualifiedName(term.qualified)
                // 构造子结果类型的 ctor.module = 所属类型模块（推断已写入时最准）
                const t = doc.visitResult?.inferred.get(term)?.type
                if (t?.kind === 'ctor') return t.ctor.module
                for (const ti of doc.visitResult?.types.values() ?? []) {
                    const ci = ti.constructors.find(c => c.ctor === term.name && c.arity === term.arity)
                    if (ci) return ci.typeCtor.module
                }
                return undefined
            }
            default:
                return term.qualified ? moduleQualifiedName(term.qualified) : undefined
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
                const modeLines = doc.visitResult?.modeSigs.get(keyOf(term.name, term.semanticArity)) ?? []
                if (modeLines.length > 0) {
                    for (const ml of modeLines) {
                        lines.push(`mode ${ml}`)
                    }
                } else if (fi.argModeRefs) {
                    // 跨模块签名无 modeSigs 展示串：从结构化 argModeRefs 渲染一行
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
            for (const ti of doc.visitResult?.types.values() ?? []) {
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
