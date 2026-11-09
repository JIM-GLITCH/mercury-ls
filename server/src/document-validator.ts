import { CancellationToken, Diagnostic } from 'vscode-languageserver'
import { MercuryDocument } from './document-manager'
import type { MercuryServices } from './services'
import { interruptAndCheck } from './promise-util'
import { stream } from './stream'

export interface DocumentValidator {
    /**
     * Validates the whole specified document.
     * @param document specified document to validate
     * @param cancelToken allows to cancel the current operation
     * @throws `OperationCanceled` if a user action occurs during execution
     */
    validateDocument(document: MercuryDocument, cancelToken?: CancellationToken): Promise<Diagnostic[]>;
}

export class DefaultDocumentValidator implements DocumentValidator {
    constructor(protected readonly services: MercuryServices) {}


    async validateDocument(document: MercuryDocument, cancelToken:CancellationToken): Promise<Diagnostic[]> {
        let parseErrors = document.parseResult.errors;
        let visitErrors = this.services.index.get(document)?.errors ?? []
        let linkeErrors = document.linkResult?.errors ?? []
        // await interruptAndCheck(cancelToken);

        let diagnostics = stream(parseErrors,visitErrors,linkeErrors).toArray()

        // await interruptAndCheck(cancelToken);

        return diagnostics;
    }
}
