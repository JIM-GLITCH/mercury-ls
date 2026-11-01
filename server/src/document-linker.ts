import { CancellationToken, Diagnostic, DiagnosticSeverity } from 'vscode-languageserver'
import { MercuryDocument } from './document-manager'
import { stream } from './stream'
import { equalQualified, exportManager, moduleManager } from './document-moduleManager'
import { label, SemanticType, VisitResult } from './document-visitor'
import { Term } from './term'
import { sameArity } from './utils'
import { interruptAndCheck } from './promise-util'
import { MultiMap } from './multimap'

export interface Linker {
    /**
     * Links all cross-references within the specified document. The default implementation loads only target
     * elements from documents that are present in the `LangiumDocuments` service.
     *
     * @param document A LangiumDocument that shall be linked.
     * @param cancelToken A token for cancelling the operation.
     */
       link(document: MercuryDocument, cancelToken?: CancellationToken): Promise<void>;

    /**
    * Unlinks all references within the specified document and removes them from the list of `references`.
    *
    * @param document A LangiumDocument that shall be unlinked.
    */
    unlink(document: MercuryDocument): void;
   
}

export class DefaultLinker implements Linker{
    errors = [] as Diagnostic[]
    async link(document: MercuryDocument, cancelToken:CancellationToken ) {
        this.errors= []
        const vr = document.visitResult
        if (vr) {
            // 解析期无法区分 func 调用 / 构造子 / pred 引用的无类别 functor 引用
            // （表达式/数据位置的 `f(...)`，如 `version_array.init(N, X)`）：
            // 在此按名字与语义元数到 definition/declaration（本模块及 import/限定名
            // 指向的模块）消解；命中类别一致才标注，歧义或未命中保持无类别
            // （goto def 对无类别引用走不限类别匹配）
            for (const [name, refs] of vr.reference.entriesGroupedByKey()) {
                await interruptAndCheck(cancelToken)
                for (const ref of refs) {
                    if (ref.semanticType) continue
                    const kind = this.resolveRefKind(ref, name, vr)
                    if (kind) label(ref, kind)
                }
            }
        }
        document.linkResult = {errors:this.errors}
    }
    // 消解无类别引用的 semanticType：本模块 + import 模块（限定名则为目标模块）
    // 中同名同元数的定义/声明，全部候选类别一致时返回该类别
    private resolveRefKind(ref: Term, name: string, vr: VisitResult): SemanticType | undefined {
        let candidates = [
            ...vr.definition.get(name),
            ...vr.declaration.get(name),
        ]
        if (ref.qualified) {
            const targetDoc = moduleManager.get(ref.qualified)
            if (targetDoc?.visitResult) {
                candidates = candidates.concat(this.lookupCandidates(targetDoc.visitResult, name))
            }
        } else {
            // 全局导出索引：各模块 interface 段声明的符号，按名字直接取候选
            candidates = candidates.concat(exportManager.get(name) as Term[])
        }
        const kinds = new Set(
            candidates
                .filter(d => sameArity(d, ref) && d.semanticType)
                .map(d => d.semanticType as SemanticType)
        )
        if (kinds.size !== 1) return undefined
        return kinds.values().next().value
    }
    private lookupCandidates(vr: VisitResult, name: string): Term[] {
        return [...vr.definition.get(name), ...vr.declaration.get(name)]
    }
    addError(msg: string, term: Term) {
        this.errors.push(Diagnostic.create(
            term.range,
            msg,
            DiagnosticSeverity.Error,
            undefined,
            "linker"
        ))
    }
    unlink(document: MercuryDocument): void {
        throw new Error('Method not implemented.')
    }
    
}
export let linker = new DefaultLinker()