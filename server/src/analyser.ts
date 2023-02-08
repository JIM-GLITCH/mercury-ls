import { Diagnostic, SymbolKind, URI } from 'vscode-languageserver'
// import { ParserState } from './parser'
import { Term, clause, termRange } from './term'
import { DefTerm, Document, RefTerm } from './document'
import { error, nameArity } from './utils'
import { parse_type_defn_item } from './parse_type_defn_item'
import { moduleUriMap  } from './globalSpace'
export type SemanticType = 
    "func"|
    "pred"|
    "type"|
    "module"|
    "variable"
    
export interface AnalyseState{
    moduleUriMap: Map<string,URI>
    moduleName: string[] | undefined
    clause:clause
    document: Document
    interface: boolean;
    errors:Diagnostic[]

}
export function analyse(document:Document) {
    let ps: AnalyseState = {
        clause: document.clauses[0],
        document: document,
        interface: false,
        errors: document.errors,
        moduleName: undefined,
        moduleUriMap: moduleUriMap,
    } ;
    for (const clause of document.clauses) {
        ps.clause = clause;
        analyse_term(clause.term,ps);
    }
}
function analyse_term(node:Term,ps:AnalyseState){
    switch (nameArity(node)) {
        case ":-/1":{
            analyse_declaration(node.args[0],ps)
            break;
		}
		case ":-/2":{
			ruleHead(node.args[0],ps);
			ruleBody(node.args[1],ps);
			return 
		}

		case "-->/2":{
			DCGHead(node.args[0],ps);
			DCGBody(node.args[1],ps);
			return ;
		}
        case "=/2":{
			funcRuleHead(node.args[0],ps);
            break;
        }
		
		default:
			addPredDef(node,ps);
			break;
    }
}




function analyse_declaration(term: Term,ps:AnalyseState) {
    switch (nameArity(term)) {
        case "module/1":{
            parse_module_marker(term.args[0],ps)
            break;
        }
        case "end_module/1":{
            // parse_end_module_marker(term.args[0],ps)
            break;
        }
        case "interface/0":
            ps.interface = true;
            break;
        case "implementation/0":
            ps.interface = false;
            break;
        case "import_module/1":{
            // if(ps.interface){
                addImportModule(term.args[0],ps);
            // }
            break;
        }
        case "use_module":
            break;
        case "include_module/1":{
            if(ps.interface){
                addIncludeModule(term.args[0],ps);
            }
            break;
        }
        case "version_numbers/1":{
            break;
        }
        case "type/1":{
            // parse_type_defn_item(term.args[0],ps);
            break;
        }
        case "solver/1":
        case "pred/1":
            parse_pred_declareation(term.args[0],ps);
            break;
        case "func/1":
            parse_func_decl(term.args[0],ps);
        case "inst/1":
        case "mode/1":
        case "typesclass/1":
        case "instance/1":
        case "pragam/1":
        case "promise/1":
        case "initialise/1":
        case "finalise/1":
        case "mutable/1":
            break;
        case "<=/2":{
            analyse_declaration(term.args[0],ps);
        }

        default:
            break;
    }
}

function ruleHead(term: Term, ps: AnalyseState) {
    switch (nameArity(term)){
        case "=/2":{
            funcRuleHead(term.args[0],ps);
            break
        }
        case "./2":
            let qualifiedTerm = parse_qualified_term(term,ps);
            addPredDef(qualifiedTerm,ps);
            break;
        default:
            addPredDef(term,ps);
    }
}
function funcRuleHead(term:Term,ps:AnalyseState){
    if(term.syntaxType=="variable"){
        error("can't be variable",term.token,ps);
        return
    }
    let qualifiedTerm = parse_qualified_term(term,ps);
    addFuncDef(qualifiedTerm,ps);
}
function ruleBody(term: Term, ps: AnalyseState) {
    switch (nameArity(term)) {
        case "some/2":
        case "all/2":{
            ruleBody(term.args[1],ps);
            break;
        }
        case ",/2":
        case "&/2":
        case ";/2":
        {
            ruleBody(term.args[0],ps);
            ruleBody(term.args[1],ps);
            break;
        }
            
        case "true":
        case "fail":
        {
            break;
        }
        case "not/1":
        case "\\+/1":
        {
            ruleBody(term.args[0],ps);
            break;
        }
        case "=>/2":
        case "<=/2":
        case "<=>/2":
        case "else/2":{
            ruleBody(term.args[0],ps);
            ruleBody(term.args[1],ps);
            break;
        }
        
        case "if/1":{
            ruleBody(term.args[0],ps);
            break;
        }
        case "then/2":
        case "->/2":
        case "=/2":
        case "\\=/2":{
            ruleBody(term.args[0],ps);
            ruleBody(term.args[1],ps);
            break;
        }
        /** 
         * TODO:
         * call/N
         * Var/N
         */
        case "promise_pure/1":
        case "promise_semipure/1":
        case "promise_impure/1":{
            ruleBody(term.args[0],ps);
            break;
        }
        case "promise_equivalent_solutions/2":
        case "promise_equivalent_solution_sets/2":{
            ruleBody(term.args[1],ps);
            break;
        }


        case "require_det/1":
        case "require_semidet/1":
        case "require_multi/1":
        case "require_nondet/1" :
        case "require_cc_multi/1" :
        case "require_cc_nondet/1" :
        case "require_erroneous/1" :
        case "require_failure/1" :{
            ruleBody(term.args[0],ps);
            break;
        }

        case "require_complete_switch/2":

        case "require_switch_arms_det/2":
        case "require_switch_arms_semidet/2":
        case "require_switch_arms_multi/2":
        case "require_switch_arms_nondet/2":
        case "require_switch_arms_cc_multi/2":
        case "require_switch_arms_cc_nondet/2":
        case "require_switch_arms_erroneous/2":
        case "require_switch_arms_failure/2":

        case "disable_warnings/2":
        case "disable_warning/2":
        case "trace/2":{
            ruleBody(term.args[1],ps);
            break;
        }
        
        case "catch_any/2":
        case "catch/2":
        case "try/2":{
            ruleBody(term.args[0],ps);
            ruleBody(term.args[1],ps);
            break;
        }
        case "event/1":{
            ruleBody(term.args[0],ps);
            break;
        }
        case "./2":
        // case ":/2":
        {
            let qualifiedTerm = parse_qualified_term(term,ps)
            addRef(qualifiedTerm,ps);
            break;
        }
        default:
            if(term.token.type=="variable"){
                return
            }
            addRef(term,ps);
    }
}

function DCGHead(term: Term, ps: AnalyseState) {
    DCGfixArity(term);
    addFuncDef(term,ps);
}

function DCGBody(term: Term, ps: AnalyseState) {
    switch (nameArity(term)) {
        case "some/2":
        case "all/2":{
            DCGBody(term.args[1],ps);
            break;
        }
        case ",/2":
        // case "&/2":
        case ";/2":
        {
            DCGBody(term.args[0],ps);
            DCGBody(term.args[1],ps);
            break;
        }
        case  '{}/1':{
            ruleBody(term.args[0],ps);
            break;
        }
        // case "[|]/2":
        // case "[]/0":
        // case "true":
        // case "fail":
        case "not/1":
        case "\\+/1":
        {
            DCGBody(term.args[0],ps);
            break;
        }
        // case "=>/2":
        // case "<=/2":
        // case "<=>/2":
        case "else/2":{
            DCGBody(term.args[0],ps);
            DCGBody(term.args[1],ps);
            break;
        }
        
        case "if/1":{
            DCGBody(term.args[0],ps);
            break;
        }
        case "then/2":
        case "->/2":
        // case "=/2":
        // case "\\=/2":
        {
            DCGBody(term.args[0],ps);
            DCGBody(term.args[1],ps);
            break;
        }
        case "=/1":
        case ":=/1":{
            ruleBody(term.args[0],ps);
            break;
        }
        case "=^/2":
        case ":=/2":{
            ruleBody(term.args[0],ps);
            ruleBody(term.args[1],ps);
            break;
        }
        case "^/1":{
            ruleBody(term.args[0],ps);
            break;

        }
        default:
            if(term.token.type!="variable"){
                DCGfixArity(term);
                addRef(term,ps);
            }
    }
}

function addFuncDef(node: Term, ps: AnalyseState) {
    ps.document.funcDefMap.add(node.name,node as DefTerm);
    node.clause = ps.clause
    node.semanticType = "func";
    ps.clause.calleeNode =node
}
function addPredDef(node: Term, ps: AnalyseState) {
    if(node.syntaxType=="variable"){
        error(" can't be variable",node.token,ps);
        return
    }
    ps.document.predDefMap.add(node.name,node as DefTerm);
    node.clause = ps.clause
    node.semanticType = "pred";
    ps.clause.calleeNode = node;
}
function addRef(term: Term, ps: AnalyseState) {
    term.clause = ps.clause;
    switch (term.syntaxType) {
        case 'string':
        case 'variable':
        case 'integer':
        case 'float':
            return;
        case 'atom':
        case 'implementation_defined':
    }
    ps.document.refMap.add(term.name,term as RefTerm)
    ps.clause.calledNodes.push(term as RefTerm);
}
// function addFuncRef(node: Term, ps: AnalyseState) {
//     node.clause = ps.clause;
//     ps.document.funcRefMap.add(node.name,node)
//     ps.clause.refTerms.push(node);
// }
// function addPredRef(node: Term, ps: AnalyseState) {
//     node.clause = ps.clause;
//     ps.document.predRefMap.add(node.name,node)
//     ps.clause.refTerms.push(node);
// }
function addIncludeModule(term: Term, ps: AnalyseState) {
    let moduleName  =  getModuleList(term,ps)
    if(moduleName){
        ps.document.includeModules.add(moduleName.join("."));
    }
}

function addImportModule(term: Term, ps: AnalyseState) {
    let moduleName  =  getModuleList(term,ps)
    if(moduleName){
        ps.document.includeModules.add(moduleName.join("."));
    }
}

function parse_pred_declareation(node: Term, ps: AnalyseState) {
    switch (nameArity(node)) {
        case "is/2":
            let pred = node.args[0];
            addPredDeclaration(pred,ps)
            break;
    
        default:
            addPredDeclaration(node,ps);
            break;
    }
}
function addPredDeclaration(term:Term,ps:AnalyseState){
    term.semanticType = "pred";
    addPredDecl(term,ps)
}

function addFuncDeclaration(term: Term, ps: AnalyseState) {
    term.semanticType = "func";
    ps.document.funcDeclMap.add(term.name,term)
    if(ps.interface){
        ps.document.exportFuncs.add(term.name)
    }
}
function addPredDecl(term:Term,ps:AnalyseState) {
    ps.document.predDeclMap.add(term.name,term);
    if(ps.interface){
        ps.document.exportPreds.add(term.name)
    }
}
function parse_func_decl(term: Term, ps: AnalyseState) {
    switch (nameArity(term)) {
        case "=/2":
            let func = term.args[0];
            addFuncDeclaration(func,ps)
            break;
        default:
            addFuncDeclaration(term,ps);
            break;
    }
}


function DCGfixArity(term: Term) {
    term.arity+=2;
}
function parse_module_marker(term: Term, ps: AnalyseState) {
    let module_list = getModuleList(term,ps);
    if(!module_list) return ;
    // 处理module list
    let parent_modules_names: string[] = [];
    for (const moduleTerm of module_list) {
        
        moduleTerm.qualification = parent_modules_names.join(".");
        parent_modules_names.push(moduleTerm.name);

        addModuleDef(moduleTerm,ps)
    }
    ps.clause.calleeNode = module_list.pop()!;

}
// function parse_end_module_marker(term: Term, ps: AnalyseState) {
//     let endModuleName = getModuleList(term,ps);
//     if(!endModuleName) return ;
//     if(!ps.moduleName) return ;
//     if(!matchName(ps.moduleName,endModuleName)){
//         error("end module name is not same with module name",term.token,ps);
//     }
// }


function parse_qualified_term(term: Term,ps:AnalyseState) {
    // 判断term是不是 qualified term 如果不是 直接返回term;如果是  返回最右边的term
    switch(nameArity(term)){
        // case ":/2":
        case "./2":
            break;
        default:
            return term;
    }

    let right_term = term.args[1];
    term = term.args[0];
    let list = [];
    forloop:
    for(;;){
        switch(nameArity(term)){
            case ":/2":
            case "./2":{
                if(term.args[1].arity!=0){
                    error("invalid module name",term.args[1].token,ps)
                    break forloop 
                }
                
                term.args[1].semanticType = "module"
                list.push(term.args[1].name);
                
                term = term.args[0];
                continue;
            }
            default:
                if(term.arity!=0){
                    error("invalid module name",term.args[1].token,ps)
                    break forloop 
                }
                term.semanticType = "module";
                list.push(term.name);
                break forloop;
        }
    }
    right_term.qualification = list.reverse().join(".");
    return right_term;
}
function getModuleList(term: Term,ps:AnalyseState) {
    let list = [];
    forloop:
    for(;;){
        switch(nameArity(term)){
            case ":/2":
            case "./2":{
                if(term.args[1].arity!=0){
                    error("invalid module name",term.args[1].token,ps)
                    return 
                }
                
                term.args[1].semanticType = "module"
                list.push(term.args[1]);
                
                term = term.args[0];
                continue;
            }
            default:
                if(term.arity!=0){
                    return 
                }
                term.semanticType = "module";
                list.push(term);
                break forloop;
        }
    }
    return list.reverse();
}

function matchName(moduleName: string[], fileNameWithoutExt: string[]) {
    let length = Math.min(moduleName.length,fileNameWithoutExt.length);
    for (let index = 0; index < length; index++) {
        const element1 = moduleName[moduleName.length-1-index];
        const element2 = fileNameWithoutExt[fileNameWithoutExt.length-1-index];
        if(element1 != element2){
            return false;
        }
    }
    return true;
}

function addModuleDef(moduleTerm:Term,ps:AnalyseState){
    ps.document.moduleDefMap.add(moduleTerm.name,moduleTerm);
    // ps.document.defsMap.add(moduleName,ps.clause);
}


