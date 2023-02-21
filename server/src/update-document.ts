// import { CancellationToken } from 'vscode-languageserver'
// import {URI } from"vscode-uri"
// import { documentMap } from './globalSpace'
// import { DocumentState } from './document'
// async function update(changed: URI[], deleted: URI[], cancelToken = CancellationToken.None): Promise<void> {
//     for (const deletedDocument of deleted) {
//         invalidateDocument(deletedDocument);
//     }
//     // this.indexManager.remove(deleted);
//     for (const changedUri of changed) {
//         invalidateDocument(changedUri);
//     }
//     for (const listener of this.updateListeners) {
//         listener(changed, deleted);
//     }
//     // Only interrupt execution after everything has been invalidated and update listeners have been notified
//     await interruptAndCheck(cancelToken);
//     const changedDocuments = changed.map(e => this.langiumDocuments.getOrCreateDocument(e));
//     const rebuildDocuments = this.collectDocuments(changedDocuments, deleted);
//     const buildOptions: BuildOptions = {
//         // This method is meant to be called after receiving a change notification from the client,
//         // so we assume that we want diagnostics to be reported in the editor.
//         validationChecks: 'all'
//     };
//     await this.buildDocuments(rebuildDocuments, buildOptions, cancelToken);
// }

// function invalidateDocument(uri: URI) {
//     const uriString = uri.toString();
//     const doc = documentMap.get(uriString);
//     if (doc) {
//         doc.state = DocumentState.Changed;
//         documentMap.delete(uriString);
//     }
// }
