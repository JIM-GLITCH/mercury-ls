import { Hover, HoverParams, MarkupContent } from 'vscode-languageserver'
import { semanticNameArityOf } from './utils'
import { search, termRange } from './term'
import { URI } from 'vscode-uri'
import { merTypeToString, keyOf } from './document-type'
import type { MercuryServices } from './services'

export async function HoverProvider(services: MercuryServices, params:HoverParams) {
    let pos = params.position;
    let uri = params.textDocument.uri;
    let doc = services.documents.getOrCreateDocument(URI.parse(uri));
    let  term  = search(doc.parseResult.value,pos)
    if(!term)
        return 
    let header: string
    if(term.semanticType){
        switch (term.semanticType){
            case 'func':
            case 'pred':
            case 'type':
            case "inst":
            case "mode":
            case "constructor":
            case "typeclass":
            case "instance":
            case "pragma":
            case "operator":
                header = `(${term.semanticType}) ${semanticNameArityOf(term)}`
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
                header = semanticNameArityOf(term);
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
            // 本模块优先；跨模块引用（uint.cast_to_int 等）落全局导出索引
            const fi = doc.visitResult?.funcs.get(keyOf(term.name, term.semanticArity))
                ?? doc.visitResult?.preds.get(keyOf(term.name, term.semanticArity))
                ?? services.exportManager.lookupFunc(term.name, term.semanticArity)
            if (fi) {
                const args = fi.argTypes.map(merTypeToString).join(', ')
                const lines = [term.semanticType === 'func'
                    ? `type ${fi.name}(${args}) = ${fi.resultType ? merTypeToString(fi.resultType) : '?'}`
                    : `type ${fi.name}(${args})`]
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
                        ? `mode ${fi.name}(${argModes}) = (${fi.resultModeRef ? refName(fi.resultModeRef) : 'out'})`
                        : `mode ${fi.name}(${argModes})`)
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
                    const head = args ? `${ci.ctor}(${args})` : ci.ctor
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