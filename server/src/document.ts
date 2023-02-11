import { Diagnostic, Position, URI } from 'vscode-languageserver'
import { Term, clause } from './term'
import { MultiMap } from './multimap'
import { URI as URI_obj,Utils } from 'vscode-uri'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { SemanticType } from './analyser'
export interface RefTerm extends Term{
    clause:clause
}
export interface DefTerm extends Term{
    clause:clause
    semanticType:SemanticType
}
export interface DeclTerm extends Term{
}
export interface ModuleTerm extends Term{
}
export type DefMap={
    "func":MultiMap<string,DefTerm>
    "pred":MultiMap<string,DefTerm>
    "type":MultiMap<string,DefTerm>
    module:Map<string,ModuleTerm>
}
export type DeclMap={
    "func":MultiMap<string,DeclTerm>
    "pred":MultiMap<string,DeclTerm>
    "type":MultiMap<string,DeclTerm>
}

export class Document{
    refMap: MultiMap<string,RefTerm>
    moduleDefMap: Map<string,Term>
    defMap: DefMap
    declMap: DeclMap
    moduleRefMap: MultiMap<string,ModuleTerm>
    getText (): string  {
        return this.textDocument.getText();
    }
    version: number
    uri:URI
    uri_obj:URI_obj
    clauses:clause[];
    funcDefMap:MultiMap<string,DefTerm>
    funcRefMap: MultiMap<string, RefTerm>
    funcDeclMap:MultiMap<string, DeclTerm>
    predDefMap:MultiMap<string,DefTerm>
    predRefMap: MultiMap<string, RefTerm>
    predDeclMap:MultiMap<string, DeclTerm>
    typeDefMap: MultiMap<string, DefTerm>
    typeRefMap: MultiMap<string, Term>
    typeDeclMap: MultiMap<string, DeclTerm>
    includeModules:Set<string>
    importModules: Set<string>
    exportFuncs: Set<string>
    exportPreds: Set<string>
    exportTypes: Set<string>
    fileNameWithoutExt: string
    textDocument:TextDocument
    errors: Diagnostic[]
    constructor(textDocument:TextDocument){
        this.textDocument = textDocument;
        this.uri = textDocument.uri
        this.clauses = []
        this.funcDefMap= new MultiMap();
        this.funcRefMap= new MultiMap();
        this.funcDeclMap= new MultiMap();
        this.typeDefMap= new MultiMap();
        this.typeRefMap= new MultiMap();
        this.typeDeclMap= new MultiMap();
        this.predDefMap= new MultiMap();
        this.predRefMap = new MultiMap()
        this.predDeclMap = new MultiMap()
        this.includeModules = new Set();
        this.importModules = new Set();
        this.exportFuncs =new Set();
        this.exportPreds =new Set();
        this.exportTypes =new Set();
        this.uri_obj = URI_obj.parse(this.uri)
                                                     // slice(0,-2) 去掉  文件名中的 ".m"
        this.fileNameWithoutExt = Utils.basename(this.uri_obj).slice(0,-2);
        this.errors = [];
        this.version = textDocument.version;
        this.refMap = new MultiMap()
        this.moduleDefMap=new Map();
        this.moduleRefMap = new MultiMap();
        this.defMap={
            "func":this.funcDefMap,
            "pred":this.predDefMap,
            "type":this.typeDefMap,
            module:this.moduleDefMap
            
        }
        this.declMap={
            "func":this.funcDeclMap,
            "pred":this.predDeclMap,
            "type":this.typeDeclMap
        }
    }
    search(pos:Position){ 
        let clauses = this.clauses;
        let low = 0, high =clauses.length-1;
        const line = pos.line;
        while (low <= high){
            const mid = Math.floor((low + high)/2)
            const clause = clauses[mid];
            let clauseRange = clause.range();
            if (clauseRange.start.line>line){
                high = mid-1;
            }
            else if(clauseRange.end.line<line){
                low = mid + 1;
            }
            else{
                    return clause.search(pos);

            }
        }
    }
    toString(){
        return this.uri;
    }
}