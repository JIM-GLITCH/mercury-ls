import { URI } from 'vscode-languageserver'
import { Token, TokenList, lexer } from './lexer';
import { OpInfo, adjust_priority_for_assoc, lookup_op, lookup_op_infos, max_priority, opTable } from './ops'

type TermKind = "OrdinaryTerm"|"Argument"|"ListElem"
class TokenIter {
	tokens
	idx
	constructor(tokens: Token[], idx: number = 0) {
		this.tokens = tokens
		this.idx = idx
	}
	val(): Token | undefined {
		return this.tokens[this.idx]
	}
	next() {
		return new TokenIter(this.tokens, this.idx + 1)
	}
}
function parseTokens(tokenList:TokenList) {
	let tokens  = tokenList.tokens;
	if(tokens.length ==0){
		return;
	}
	let p = new TokenIter(tokens);
	let state = initParserState();
	let {term,leftOverTokens}
	
}
function error(msg:string,p:TokenIter,ps:ParserState) {
	
}
interface ParserState{
	uri:URI
	varset:Set<string>
	varmap:Map<string,Term>

}
type Term = any 
type readRes={
	term:Term,
	p:TokenIter
}
function parse_whole_term(p:TokenIter,ps:ParserState):Term{
	let r= read(max_priority+1,"OrdinaryTerm",);
	if(r.term){
		if(r.p.val()==undefined){
			return r.term
		}
		else{
			error("operator expected",r.p,ps);
			return r.term;
		}
	}
	return r.term;
}

function parse_term(p: TokenIter, ps: ParserState): readRes{
	return do_parse_term(max_priority+1,"OrdinaryTerm",p,ps);
}
function do_parse_term(max_priority:number,termKind:TermKind,p:TokenIter,ps:ParserState): [Term,TokenIter]{
	let []=parse_left_term(max_priority,termKind,p,ps)
}
function parse_left_term(max_priority:number,termKind:TermKind,p:TokenIter,ps:ParserState)
:[Term,Number,TokenIter] {
	let token = p.val()
	let pnext = p.next()
	let nextToken=pnext.val();

	if(!token) return [undefined,0,p];

	if(token.type =="name" 
	&& token.value =="-" 
	){
		if( nextToken?.type=="integer" ){
			let term  =new negInteger(nextToken,token);
			return [term,0,p.next()]
		}
		if(nextToken?.type=="float"){
			let term  =new negFloat(nextToken,token);
			return [term,0,p.next()]
		}

	}
	let opinfos
	if(token.type =="name" && (opinfos=lookup_op_infos(token.value))){
		let BinOpinfo
		// % Check for binary prefix op.
        // %
        // % Since most tokens aren't binary prefix ops, the first test
        // % here will almost always fail.
		if((BinOpinfo = find_binary_prefix_op(opinfos))
		&&	BinOpinfo[3]<=max_priority
		&&	nextToken
		&&	could_start_term(nextToken)
		&& nextToken.type!="open_ct"
		){
			let oppriority = BinOpinfo[3];
			let rightAssoc = BinOpinfo[1];
			let rightRightAssoc = BinOpinfo[2];
			let rightPriority = adjust_priority_for_assoc(oppriority,rightAssoc);
			let rightRightPriority = adjust_priority_for_assoc(oppriority,rightRightAssoc);
			let [rRes,p1] =do_parse_term(rightPriority,termKind,p,ps);
			let [rrRes,p2] = do_parse_term(rightRightPriority,termKind,p1,ps);
			let term = new binPrefixCompound(token,[rRes,rrRes]);
			return [term,oppriority,p2]
		}
		// % Check for prefix op.
		// %
		// % Since most tokens aren't prefix ops, the first test
		// % here will almost always fail.
		let prefixOPinfo
		if((prefixOPinfo = find_prefix_op(opinfos))
		&&	prefixOPinfo[2]<=max_priority
		&& nextToken
		&& could_start_term(nextToken)
		&& nextToken.type!="open_ct"
		){
			let oppriority = prefixOPinfo[2];
			let rightAssoc = prefixOPinfo[1]
			let rightPriority = adjust_priority_for_assoc(oppriority,rightAssoc);
			let [rightRes,p1]=do_parse_term(rightPriority,termKind,p,ps);
			let term = new prefixCompound(token,[rightRes]);
			return [term,oppriority,p1];
		}
	}
	// TokenName is operator but treat as not operator
	// % TokenName is not an operator.
	parse_simple_term(p,max_priority,ps);
}
function parse_simple_term(p:TokenIter,prec:number,ps:ParserState):[Term,TokenIter]{
	let token =p.val()!
	let pnext = p.next()
	let nextToken = pnext.val();
	let pnextnext = pnext.next();
	let baseterm:Term;
	let basep:TokenIter=p;
	if(token.type=="name"){
		if(nextToken?.type=="open_ct"){
			let [Args,p1]=parse_args(pnextnext,ps,[]);
			let term = new functorCompound(token,Args);
			baseterm = term;
			basep = p1;
		}
		else if(lookup_op(token.value)
		&& prec<=max_priority
		){
			error("unexpected token at start of (sub)term",p,ps)
			let term = new recoveryNode(token);
			baseterm= term;
			basep = pnext;
		}
		else{
			let term = new atom(token);
			baseterm = term;
			basep= pnext;
		}
	}
	else if(token.type=="variable"){
		add_var(token,ps);
		let term = new variable(token);
		baseterm = term;
		basep= pnext;
	}
	else if(token.type=="integer"){
		let term = new integer(token);
		baseterm = term;
		basep= pnext;
	}
	else if(token.type =="float"){
		let term = new float(token);
		baseterm = term;
		basep= pnext;
	}
	else if(token.type =="string"){
		let term = new string(token);
		baseterm = term;
		basep= pnext;
	}
	else if(token.type=="implementation_defined"){
		let term = new implementation_defined(token);
		baseterm = term;
		basep= pnext;
	}
	else if(token.type =="open"
	|| token.type =="open_ct"
	){
		let [term,p1] = parse_term(pnext,ps);
		let token = p1.val()
		let p2 = p1.next() 
		if (token?.type=="close"){
			baseterm = term;
			basep= p2;
		}
		else{
			error("expecting `)' or operator",p1,ps);
			baseterm = term;
			basep= p2;
		}
	}
	else if(token.value =="[]"||token.value =="{}"){
		let [term,p1]= parse_special_term(token,pnext,ps);
		baseterm = term;
		basep= p1;

	}
	else if(token.type =="open_list"){
		// % This is a slight departure from ISO Prolog syntax -- instead of
		// % parsing "{1,2,3}" as "'{}'(','(1, ','(2, 3)))", we parse it as
		// % "'{}'(1,2,3)". This makes the structure of tuple functors
		// % the same as other functors.
		// let [term,p1]=parse_list(pnext,ps);
		// baseterm = term;
		// basep= p1.next();
		let [arg0 ,p1] = parse_list_elem(pnext,ps);
		let [args ,p2] = read_list(p1,ps);
	}
	else if(token.type =="open_curly"){
		let[subterm,p1 ]=parse_term(pnext,ps);
		let token1 = p1.val()
		let p2 = p1.next();
		let argTerms = conjuntion_to_list(subterm);
		let term = new list(token,argTerms);
		baseterm = term;
		basep= p2;
		if(token1?.type=="close_curly"){	
			// nothing
		}
		else{
			error("expecting `}' or operator",p1,ps);
		}
	}
	else if(token.type=="close"
	||token.type=="close_list"
	||token.type=="close_curly"
	||token.type=="ht_sep"
	||token.type=="comma"
	||token.type=="end"
	||token.type=="junk"
	||token.type=="error"
	){
		error("unexpected token at start of (sub)term",pnext,ps);
		let term = new recoveryNode(token)
		baseterm = term;
		basep= pnext;
	}
	let baseToken = basep.val();
	let basepnext = basep.next();
	if(baseterm
	&& baseToken?.type=="open_ct"){
			return parse_higher_order_term_rest(baseterm,basepnext,ps)
	}
	else{
		return [baseterm,basepnext]
	}
}
// % As an extension to ISO Prolog syntax, we check for the syntax
// % "Term(Args)", and parse it as the term ''(Term, Args). The aim
// % of this extension is to provide a nicer syntax for higher-order stuff.
// %
// % Our caller should call us after it has seen "Term("; we parse
// % the remainder, "Args)".
// %
// % The recursive call allows us to parse "Term(Args1)(Args2)" as well.
// %
function parse_higher_order_term_rest(baseterm:Term,p:TokenIter,ps:ParserState):[Term,TokenIter]{
	let[args,p1]=parse_args(p,ps);
	let applyterm = new applyCompound([baseterm,...args]);
	let token1 = p1.val();
	let p2 = p1.next();
	if(token1?.type=="open_ct"){
		return parse_higher_order_term_rest(applyterm,p2,ps);
	}
	else{
		return [applyterm,p1];
	}

}
function parse_args(p:TokenIter,ps:ParserState,list:Term[] = []):[Term[],TokenIter]{

	let [Arg0,p1] =parse_arg(p,ps);
	let token1 = p1.val();
	let p2 = p1.next();
	list.push(Arg0);
	if(token1?.type=="comma"){
		let [_,p3]=parse_args(p2,ps,list);
		return [list,p3];
	}
	if(token1?.type=="close"){
		return [list,p2];
	}
	// TODO
	return [list,p1];
}
function parse_arg(p:TokenIter,ps:ParserState){
	let argPriority =max_priority+1;
	return do_parse_term(argPriority,"Argument",p,ps);
}
function find_binary_prefix_op(opinfos: OpInfo[]) {
	for (const opinfo of opinfos) {
		if (opinfo[0]=="BinaryPrefix"){
			return opinfo;
		}
	}
	return ;
}
function find_prefix_op(opinfos: OpInfo[]) {
	for (const info of opinfos) {
		if(info[0]=="Prefix")
			return info
	}
}
	
function could_start_term(nextToken: Token) {
	switch (nextToken.type) {
		case "name":
		case "variable":
		case "integer":
		case "float":
		case "string":
		case "implementation_defined":
		case "open":
		case "open_ct":
		case "open_list":
		case "open_curly":
			return true
		case "close":
		case "close_list":
		case "close_curly":
		case "ht_sep":
		case "comma":
		case "end":
		case "junk":
		case "error":
		default:
			return false

	}
}



function add_var(token: Token, ps: ParserState) {
	if(token.text[0]=="_"){

	}
}

function conjuntion_to_list(term: any) {
	let list = [];
	while(term.functor.value ==","&& term.children.length==2){
		list.push(term.children[0]);
		term = term.children[1]
	}
	list.push(term);
	return list;
}

function parse_special_term(token: Token, pnext: TokenIter, ps: ParserState): [any, TokenIter] {
	let tokenNext = pnext.val();
	if(tokenNext?.type=="open_ct"){
		let [args0,p1]=parse_args(pnext.next(),ps);
		let term  = new functorCompound(token,args0);
		return [term,p1];
	}
	else{
		let term = new atom(token);
		return [term,pnext];
	}
}

function parse_list(p: TokenIter, ps: ParserState): [any, any] {
	let [arg0,p1] = parse_list_elem(p,ps);
	return parse_list_tail(arg0,p1,ps);
}

function parse_list_elem(p:TokenIter,ps:ParserState) {
	let argPriority = max_priority+1;
	return do_parse_term(argPriority,"ListElem",p,ps);
}

function parse_list_tail(arg0: Term, p1: TokenIter, ps: ParserState): [any, any] {
	let token1 = p1.val();
	let p2 = p1.next();
	if(!token1){
		error("unexpected end-of-file in list",p1,ps);
		let term = arg0;
		return [term,p1];
	}
	if(token1.type =="comma"){
		let [tail0,p3] = parse_list(p2,ps);
		let functor = 
		let term = new functorCompound()
	}
	else if(token1.type == "ht_sep"){

	}
	else if(token1.type =="close_list")

}

function read_list(p1: TokenIter, ps: ParserState) {
	let token1 = p1.val();
	let p2 = p1.next();
	switch (token1?.type) {
		case "comma":{
			let [arg0,p2] = parse_list_elem()

		}
		case "ht_sep":{

		}
		case "close_list":{

		}
	
		default:
			break;
	}
}

function read(MaxPriority: number, termKind: TermKind,p1:TokenIter,ps:ParserState):readRes {
	let token1 = p1.val();
	let p2 =p1.next();
	let token2 = p2.val();
	let opinfos;
	if(!token1){
		error("unexpected end-of-file at start of sub-term",p1,ps);
		return {term:undefined,p:p1};
	}
    //  parse special case or operator notaion case 
	if(token1.type =="name" 
	&& token1.value =="-" 
	&& token2
	){
		if( token2.type=="integer" ){
			let term  =new negInteger(token2,token1);
			// return [term,0,p.next()]
			return bottom_up()
		}
		if( token2.type=="float"){
			let term  =new negFloat(nextToken,token);
			// return [term,0,p.next()]
			return bottom_up();
		}

	}
	
	else if(token1.type =="name" &&(opinfos=lookup_op_infos(token1.value))){
		let BinOpinfo
        let prefixOPinfo
		// % Check for binary prefix op.
        // %
        // % Since most tokens aren't binary prefix ops, the first test
        // % here will almost always fail.
		if((BinOpinfo = find_binary_prefix_op(opinfos))
		&&	BinOpinfo[3]<=MaxPriority
		&&	token2
		&&  could_start_term(token2)
		&& 	token2.type!="open_ct"
        ){
            let oppriority = BinOpinfo[3];
			let rightAssoc = BinOpinfo[1];
			let rightRightAssoc = BinOpinfo[2];
            let rightPriority = adjust_priority_for_assoc(oppriority,rightAssoc);
			let rightRightPriority = adjust_priority_for_assoc(oppriority,rightRightAssoc);
			let r1 = read(rightPriority,termKind,p2,ps);
			let r2 = read(rightRightPriority,termKind,r1.p,ps);
            let term = new binPrefixCompound(token1,[r1.term,r2.term]);
            return bottom_up()
        }	
        // % Check for prefix op.
		// %
		// % Since most tokens aren't prefix ops, the first test
		// % here will almost always fail.
        else if((prefixOPinfo = find_prefix_op(opinfos))
		&&	prefixOPinfo[2]<=MaxPriority
		&& token2
		&& could_start_term(token2)
		&& token2.type!="open_ct"
        ){
            let oppriority = prefixOPinfo[2];
			let rightAssoc = prefixOPinfo[1]
			let rightPriority = adjust_priority_for_assoc(oppriority,rightAssoc);
			let r1=read(rightPriority,termKind,p2,ps);
			let term = new prefixCompound(token1,[r1.term]);
            return bottom_up()
        }
	}
    
    
    // parse simple term 
    let p3 = p2.next();
    let baseterm;
    let basep:TokenIter;
	switch (token1.type) {
		case "name":{
			if(token2?.type=="open_ct"){
                let r1=read_args(p3,ps);
                let term = new functorCompound(token1,r1.args);
                baseterm = term;
                basep = p1;
                break;
            }
			else{
                if(lookup_op(token1.value)&& MaxPriority<=max_priority){
                    error("unexpected token at start of (sub)term",p1,ps)
                    let term = new atom(token);
                    baseterm= term;
                    basep = p2;
                    break;
                }
                else{
                    let term = new atom(token);
                    baseterm = term;
                    basep= p2;
                    break;
                }
			}
        }
		case "variable":{
            add_var(token1,ps);
            let term = new variable(token);
            baseterm = term;
            basep= p2;
            break;
        }
        case "integer":{
            let term = new integer(token);
            baseterm = term;
            basep= p2;
            break;
        }
        case "float":{
            let term = new float(token);
            baseterm = term;
            basep= p2;
            break;
        }
        case "string":{
            let term = new string(token);
            baseterm = term;
            basep= p2
            break
        }
        case "implementation_defined":{
            let term = new implementation_defined(token);
            baseterm = term;
            basep= p2;
            break;       
        }
        case "open_list":{
            let r1 = read(max_priority+1,"ListElem",p2,ps);
            let r2 = read_list(r1.p,ps);
            let term = new functorCompound(token1,[r1.term,r2.term],"[|]");
            baseterm = term;
            basep = r2.p;
            break;
        }
        case "open_curly":{
            let r1 = read(max_priority+1,"Argument",p2,ps);
            let r2 = read_args_curly(r1.p,ps);
            let term = new functorCompound(token1,[r1.term,...r2.args],"{}");
            baseterm = term;
            basep = r2.p;
            break;
        }
		default:{
            error("unexpected token at start of (sub)term",p2,ps);
            let term  = new atom(token1);
            baseterm = term;
            basep = p2;
            break;
        }
	}

    // parse higher order term rest

    // % As an extension to ISO Prolog syntax, we check for the syntax
    // % "Term(Args)", and parse it as the term ''(Term, Args). The aim
    // % of this extension is to provide a nicer syntax for higher-order stuff.
    // %
    // % Our caller should call us after it has seen "Term("; we parse
    // % the remainder, "Args)".
    // %
    // % The recursive call allows us to parse "Term(Args1)(Args2)" as well.
    // %
    let pp = basep;
    let tt = baseterm;
    for(;;){
        let token = pp.val();
        if (token?.type == "open_ct"){
            let r = read_args(pp.next(),ps);
            tt = new applyTerm(token,[tt,...r.args],"");
            pp = r.p;
            continue
        }
        else{
            return {term:tt,p:pp};
        }
    }

    
}


function read_args(p: TokenIter, ps: ParserState) {
    let args = [];
    let  pp = p;
    for(;;){
        let r = read(max_priority+1,"Argument",pp,ps);
        args.push(r.term);
        let token = r.p.val();
        if(!token){
            error( "expected `,', `)', or operator",r.p,ps);
            return {args:args,p:r.p};
        }
      
        if(token.type=="comma"){
            pp=r.p.next();
            continue;
        }
        if(token.type =="close"){
            pp=r.p.next();
            return {args:args,p:pp};
        }
        error( "expected `,', `)', or operator",r.p,ps);
        pp=r.p.next();
        return {args:args,p:pp}
    }
}

function read_args_curly(p: TokenIter, ps: ParserState) {
    let args = [];
    let  pp = p;
    for(;;){
        let r = read(max_priority+1,"Argument",pp,ps);
        args.push(r.term);
        let token = r.p.val();
        
        if(!token){
            error( "expected `,', `}', or operator",r.p,ps);
            return {args:args,p:r.p};
        }

        if(token.type=="comma"){
            pp=r.p.next();
            continue;
        }
        if(token.type =="close_curly"){
            pp=r.p.next();
            return {args:args,p:pp};
        }
        error( "expected `,', `}', or operator",r.p,ps);
        pp=r.p.next();
        return {args:args,p:pp}

    }
}

function bottom_up(): readRes {
    throw new Error('Function not implemented.')
}

