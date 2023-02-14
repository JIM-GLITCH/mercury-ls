import { Document } from './document'
import { docsMap, funcMap, moduleMap, predMap, refMap } from './globalSpace'



export function link(doc:Document) {
    // 首先去掉旧的索引
    let uri  =doc.uri;
    let oldDoc = docsMap.get(uri);
    if(oldDoc){
        for (const funcName of oldDoc.exportFuncs) {
            funcMap.delete(funcName,oldDoc);
        }
        for (const predName of oldDoc.exportPreds) {
            predMap.delete(predName,oldDoc);
        }
        for (const typeName of oldDoc.exportTypes) {
            funcMap.delete(typeName,oldDoc);
        }
        for (const refName of oldDoc.refMap.keys()) {
            refMap.delete(refName,oldDoc);
        }
        for (const moudleName of oldDoc.moduleDefMap.keys()) {
            moduleMap.delete(moudleName)
        }
    }
    // 然后添加新的索引
    for (const funcName of doc.exportFuncs) {
        funcMap.add(funcName,doc);
    }
    for (const predName of doc.exportPreds) {
        predMap.add(predName,doc);
    }
    for (const typeName of doc.exportTypes) {
        funcMap.add(typeName,doc);
    }
    for (const refName of doc.refMap.keys()) {
        refMap.add(refName,doc);
    }
    for (const moudleName of doc.moduleDefMap.keys()) {
        moduleMap.set(moudleName,doc);
    }
}