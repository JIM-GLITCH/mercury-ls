import { ParserState } from './parser'
import { Term, clause, termRange } from './term'
export interface AnalyseState extends ParserState{
    interface: boolean
    clause:clause
}
export function analyse(node:Term,ps:AnalyseState) {
    switch (termName(node)) {
        case ":-/1":{
            analyse_declaration(node,ps)
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
			ruleHead(node.args[0],ps);
            break;
        }
		
		default:
			addDefinition(node,ps);
			break;
    }
}
function termName(term:Term){
    return term.val+'/'+term.arity;
}


function analyse_declaration(term: Term,ps:AnalyseState) {
    let decl = term.args[0];
    switch (termName(decl)) {
        case "type/1":
        case "solver/1":
        case "pred/1":
            pred_decl(decl.args[0],ps);
            break;
        case "func/1":
            func_decl(decl.args[0],ps);
        case "inst/1":
        case "mode/1":
        case "typesclass/1":
        case "instance/1":
        case "pragam/1":
        case "promise/1":
        case "initialise/1":
        case "finalise/1":
        case "mutable/1":
        case "module/1":
            break;
        case "interface/0":
            ps.interface = true;
            break;
        case "implementation/0":
            ps.interface = false;
            break;
        case "import_module/1":{
            // if(ps.interface){
                add_import_module(decl.args[0],ps);
            // }
            break;
        }
        case "use_module":
            break;
        case "include_module/1":{
            if(ps.interface){
                add_include_module(decl.args[0],ps);
            }
            break;
        }
        case "end_module/0":
            break;
    
        default:
            break;
    }
}

function ruleHead(node: Term, ps: AnalyseState) {
    switch (termName(node)){
        case "=/2":{
            ruleHead(node.args[0],ps);
            break
        }
        default:
            addDefinition(node,ps);
    }
}

function ruleBody(node: Term, ps: AnalyseState) {
    switch (termName(node)) {
        case "some/2":
        case "all/2":{
            ruleBody(node.args[1],ps);
            break;
        }
        case ",/2":
        case "&/2":
        case ";/2":
        {
            ruleBody(node.args[0],ps);
            ruleBody(node.args[1],ps);
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
            ruleBody(node.args[0],ps);
            break;
        }
        case "=>/2":
        case "<=/2":
        case "<=>/2":
        case "else/2":{
            ruleBody(node.args[0],ps);
            ruleBody(node.args[1],ps);
            break;
        }
        
        case "if/1":{
            ruleBody(node.args[0],ps);
            break;
        }
        case "then/2":
        case "->/2":
        case "=/2":
        case "\\=/2":{
            ruleBody(node.args[0],ps);
            ruleBody(node.args[1],ps);
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
            ruleBody(node.args[0],ps);
            break;
        }
        case "promise_equivalent_solutions/2":
        case "promise_equivalent_solution_sets/2":{
            ruleBody(node.args[1],ps);
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
            ruleBody(node.args[0],ps);
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
            ruleBody(node.args[1],ps);
            break;
        }
        
        case "catch_any/2":
        case "catch/2":
        case "try/2":{
            ruleBody(node.args[0],ps);
            ruleBody(node.args[1],ps);
            break;
        }
        case "event/1":{
            ruleBody(node.args[0],ps);
            break;
        }
        default:
            if(node.token.type!="variable"){
                addReference(node,ps);
            }
    }
}

function DCGHead(arg0: Term, ps: AnalyseState) {
    // throw new Error('Function not implemented.')
}

function DCGBody(arg0: Term, ps: AnalyseState) {
    // throw new Error('Function not implemented.')
}

function addDefinition(node: Term, ps: AnalyseState) {
    ps.defsMap.add(node.val,ps.clause)
    ps.clause.calleeNode = node;
}

function addReference(node: Term, ps: AnalyseState) {
    ps.refsMap.add(node.val,node)
}

function add_include_module(arg0: Term, ps: AnalyseState) {
    ps.document.include_modules.add(arg0.val);
}

function add_import_module(arg0: Term, ps: AnalyseState) {
    ps.document.import_modules.add(arg0.val);
}

function pred_decl(node: Term, ps: AnalyseState) {
    switch (termName(node)) {
        case "is/2":
            let pred = node.args[0];
            addDeclaration(pred,ps)
            break;
    
        default:
            addDeclaration(node,ps);
            break;
    }
}


function addDeclaration(pred: Term, ps: AnalyseState) {
    ps.clause.calleeNode = pred;
    ps.document.declsMap.add(pred.val,ps.clause)
    if(ps.interface){
        ps.document.exports.add(pred.val)
    }
}

function func_decl(node: Term, ps: AnalyseState) {
    switch (termName(node)) {
        case "=/2":
            let func = node.args[0];
            addDeclaration(func,ps)
            break;
    
        default:
            addDeclaration(node,ps);
            break;
    }
}

