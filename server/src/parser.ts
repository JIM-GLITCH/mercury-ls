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
	let p = new TokenIter(tokens)；
	let state = initParserState();
	let {term,leftOverTokens}
	
}
function error(msg:string,p:TokenIter,ps:ParserState) {
	
}
interface ParserState{}
type Term = any 
function parse_whole_term(p:TokenIter,ps:ParserState):[Term,TokenIter]{
	let [term0 , p0 ] = parse_term(p,ps);
	if(term0){
		if(p0.val()?.type=="end"){
			return [term0 ,p0];
		}
		else{
			error("operator or `.' expected",p0,ps);
			return [term0 ,p0];
		}
	}
	return [term0 ,p0];
}

function parse_term(p: TokenIter, ps: ParserState): [Term,TokenIter] {
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
		let [term,p1]=parse_list(pnext,ps);
		baseterm = term;
		basep= p1.next();
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
function parse_higher_order_term_rest(baseterm:Term,p:TokenIter,ps:ParserState){
	let[args,p1]=parse_args(p,ps);
	let applyterm = new functorCompound()
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
	throw new Error('Function not implemented.')
}

function conjuntion_to_list(subterm: any) {
	throw new Error('Function not implemented.')
}

function parse_special_term(token: Token, pnext: TokenIter, ps: ParserState): [any, TokenIter] {
	throw new Error('Function not implemented.')
}

