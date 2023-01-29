import { AnalyseState } from './analyser'
import { Term } from './term'
import {nameArity} from"./utils"
export function parse_type_defn_item(term:Term,ps:AnalyseState){
    switch (nameArity(term)) {
        case "--->/2":
            parse_du_type_defn(term.args[0],term.args[1],ps);
            break;
        case "==/2":
            parse_du_type_defn(term.args[0],term.args[1],ps);
            break;
        case "where/2":
            parse_where_block_type_defn(term.args[0],term.args[1],ps);
            break
        default:
            // parse_abstract_type_defn(term,ps);
            break;
    }
}

function parse_du_type_defn(arg0: Term, arg1: Term, ps: AnalyseState) {
}
function parse_where_block_type_defn(arg0: Term, arg1: Term, ps: AnalyseState) {
    throw new Error('Function not implemented.')
}

