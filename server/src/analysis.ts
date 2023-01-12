// import { ParserState } from './parser'
import { ParserState } from './parser'
import { Term, clause, termRange } from './term'
export interface AnalyseState extends ParserState{
    clause:clause
}
export function analyse(node:Term,ps:AnalyseState) {
    switch (termName(node)) {
        case ":-/1":{
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


function analyse_declaration(term: Term,d:AnalyseState) {
    let decl = term.args[0];
    switch (termName(decl)) {
        case "type/1":
        case "solver/1":
        case "pred/1":
        case "func/1":
        case "inst/1":
        case "mode/1":
        case "typesclass/1":
        case "instance/1":
        case "pragama/1":
        case "promise/1":
        case "initialise/1":
        case "finalise/1":
        case "mutable/1":
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
        case ",/2":
		case ";/2":
		case "|/2":
		// case "*->/2":
		case "->/2":{
            let nd = node;
            ruleBody(nd.args[0],ps);
            ruleBody(nd.args[1],ps);
        break;
    }
    
        default:
            break;
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
    ps.clause.callerNode = node;
}

