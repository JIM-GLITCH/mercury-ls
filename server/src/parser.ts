import { Diagnostic } from 'vscode-languageserver'
import { Token, TokenList, TokenType, lexer, } from './lexer';
import { OpInfo, adjust_priority_for_assoc, lookup_infix_op, lookup_op, lookup_op_infos, max_priority } from './ops'
import { Term, string,applyCompound, atom, backquotedapplyCompound, binPrefixCompound, clause, float, functorCompound, implementation_defined, infixCompound, integer, negFloat, negInteger, prefixCompound, variable } from './term'
import { MultiMap } from './multimap'
import type{ Document } from './document'
import { errorToken, nameArity } from './utils'

type TermKind = "OrdinaryTerm"|"Argument"|"ListElem"
class TokenIter {
	tokens
	idx
	constructor(tokens: Token[], idx: number = 0) {
		this.tokens = tokens
		this.idx = idx
	}
	val(): Token  {
		return this.tokens[this.idx]
	}
	next() {
		return new TokenIter(this.tokens, this.idx + 1)
	}
}
export function parse(document:Document){
    let ps= {
		errors: document.errors,
		varmap: new MultiMap()
	} as ParserState
    let local_lexer =  lexer.clone().reset(document.getText());
    let clauses = document.clauses;
    for(;;){
        let tokenList = local_lexer.getTokenList();
        if(!tokenList){
            break;
        }
        let clause = read_clause_from_TokenList(tokenList,ps);
        ps.varmap = new MultiMap();
        clauses.push(clause);
    }
}

export function parse_string(text:string){
    let ps= {
		errors: [] as Diagnostic[] ,
		varmap: new MultiMap()
	} as ParserState
    let local_lexer =  lexer.clone().reset(text);
    let clauses = [] as clause[];
    for(;;){
        let tokenList = local_lexer.getTokenList();
        if(!tokenList){
            break;
        }
        let clause = read_clause_from_TokenList(tokenList,ps);
        clause.varmap = ps.varmap;
        ps.varmap = new MultiMap();
        clauses.push(clause);
    }
    return {clauses,errors:ps.errors};
}

function read_clause_from_TokenList(tokenList:TokenList,ps:ParserState) {
    // push lexer errors
    let tokens  = tokenList.tokens;
    let errors = tokenList.errors;
    for (const token of errors) {
        errorToken("invalid token",token,ps);
    }

    // read term
	let p = new TokenIter(tokens);
    let r=read(max_priority+1,"OrdinaryTerm",p,ps);
    // check tokens are left
    let lastToken  = r.p.val();
    if(lastToken.type!="EOF"){
        errorToken("need an infix operator ",lastToken,ps);
    }
    // check end_of_clause token
    if(!tokenList.end){
        errorToken("missing end of clause token",lastToken,ps);
    }
    let end  = tokenList.end?? tokenList.tokens[tokenList.tokens.length-1]
    let  clauseItem= new clause(r.term,end,ps.varmap);
    return clauseItem;
}

export interface ParserState{
    calleeNode?: Term
    errors: Diagnostic[]
	varmap:MultiMap<string,Term>
}
type readRes={
	term:Term,
	p:TokenIter
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



function add_var(varTerm: Term, ps: ParserState) {

	if(varTerm.name[0]=="_"){
        return ;
	}
    ps.varmap.add(varTerm.name,varTerm);
}


// do parse term
function read(MaxPriority: number, termKind: TermKind,p1:TokenIter,ps:ParserState):readRes {
	let p2 =p1.next();
	let p3 = p2.next();
	let token1 = p1.val();
	let token2 = p2.val();
	let opinfos;
	if(token1.type=="EOF"){
		errorToken("unexpected end-of-file at start of sub-term",token1,ps);
        let term = atom(token1);
		return {term,p:p1};
	}
    //  parse special case or operator notaion case 
	if(token1.type =="name" 
	&& token1.value =="-" 
	&& token2
	){
		if( token2.type=="integer" ){
			let term  =negInteger(token2,token1);
			// return [term,0,p.next()]
			return bottom_up(MaxPriority,termKind,0,term,p3,ps);
		}
		if( token2.type=="float"){
			let term  =negFloat(token2,token1);
			// return [term,0,p.next()]
			return bottom_up(MaxPriority,termKind,0,term,p3,ps);
		}

	}
	
	if(token1.type =="name" &&(opinfos=lookup_op_infos(token1.value))){
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
            let term = binPrefixCompound(token1,[r1.term,r2.term]);
            return bottom_up(MaxPriority,termKind,oppriority,term,r2.p,ps);
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
			let term = prefixCompound(token1,[r1.term]);
            return bottom_up(MaxPriority,termKind,oppriority,term,r1.p,ps)
        }
	}
    
    
    // parse simple term 
    let baseterm;
    let basep:TokenIter;
	switch (token1.type) {
		case "name":{
			if(token2?.type=="open_ct"){
                let r1=read_args(p3,ps);
                let term =  functorCompound(token1,r1.args);
                baseterm = term;
                basep = r1.p;
                break;
            }
			else{
                if(lookup_op(token1.value)&& MaxPriority<=max_priority){
                    errorToken("unexpected token at start of (sub)term",token1,ps)
                    let term =  atom(token1);
                    baseterm= term;
                    basep = p2;
                    break;
                }
                else{
                    let term =  atom(token1);
                    baseterm = term;
                    basep= p2;
                    break;
                }
			}
        }
		case "variable":{
            let term =  variable(token1);
            add_var(term,ps);
            baseterm = term;
            basep= p2;
            break;
        }
        case "integer":{
            let term =  integer(token1);
            baseterm = term;
            basep= p2;
            break;
        }
        case "float":{
            let term =  float(token1);
            baseterm = term;
            basep= p2;
            break;
        }
        case "string":{
            let term =  string(token1);
            baseterm = term;
            basep= p2
            break
        }
        case "implementation_defined":{
            let term =  implementation_defined(token1);
            baseterm = term;
            basep= p2;
            break;       
        }
        case "open":
        case  "open_ct":{
            let r1 = read(max_priority+1,"OrdinaryTerm",p2,ps);
            let token = r1.p.val()
            if(token.type == "close"){
                baseterm = r1.term;
                basep = r1.p.next()
                break;
            }
            errorToken("expecting `)' or operator",token,ps);
            baseterm = r1.term;
            basep = r1.p
            break;


        }
        case "open_list":{
            let r1 = read(max_priority+1,"ListElem",p2,ps);
            let r2 = read_list(r1.p,ps);
            let term =  functorCompound(token1,[r1.term,r2.term],"[|]");
            baseterm = term;
            basep = r2.p;
            break;
        }
        case "open_curly":{
            let r1 = read_args_curly(p2,ps);
            let term =  functorCompound(token1,r1.args,"{}");
            baseterm = term;
            basep = r1.p;
            break;
        }
		default:{
            errorToken("unexpected token at start of (sub)term",token2,ps);
            let term  =  atom(token1);
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
        if (token.type == "open_ct"){
            let r = read_args(pp.next(),ps);
            tt =  applyCompound(token,[tt,...r.args]);
            pp = r.p;
            continue
        }
        else{
            return bottom_up(MaxPriority,termKind,0,tt,pp,ps);
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
        if(token.type=="EOF"){
            errorToken( "expected `,', `)', or operator",token,ps);
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
        errorToken( "expected `,', `)', or operator",token,ps);
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
        
        if(token.type=="EOF"){
            errorToken( "expected `,', `}', or operator",token,ps);
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
        errorToken( "expected `,', `}', or operator",token,ps);
        pp=r.p;
        continue
    }
}
function read_list(p1: TokenIter, ps: ParserState):readRes {
    let p2 = p1.next();
    let token1 = p1.val();
    switch (token1.type) {
        case "EOF":{
            errorToken("unexpected end-of-file in list",token1,ps);
            let term =  atom(token1,"[]");
            return {term,p:p1};
        }
        case "comma":{
            let r1 = read(max_priority+1,"ListElem",p2,ps);
            let r2 = read_list(r1.p,ps);
            let term =  functorCompound(token1,[r1.term,r2.term],"[|]");
            return {term,p:r2.p};

        }
        case "ht_sep":{
            let r1 = read(max_priority+1,"Argument",p2,ps);
            let token = r1.p.val();
            if(token.type == "close_list"){
                return {term:r1.term,p:r1.p.next()};
            }else{
                errorToken("unexpected token",token1,ps);
                let r2  = skipUntil("close_list",r1.p,ps);
                return {term:r1.term,p:r2.p}
            }
            
        }
        case "close_list":{
            let term =  atom(token1,"[]");
            return {term,p:p2};
        }
        default:{
            errorToken("missing comma",token1,ps);
            let r1 = read(max_priority+1,"ListElem",p1,ps);
            let r2 = read_list(r1.p,ps);
            let term =  functorCompound(token1,[r1.term,r2.term],"[|]");
            return {term,p:r2.p};
        }
    }
}
function bottom_up(MaxPriority:number,termKind:TermKind,lpriority:number,lterm:Term,p1:TokenIter,ps:ParserState): readRes {
    let p2 = p1.next();
    let token1 = p1.val();
    // let token2 =p2.val();
    if(token1.type == "EOF"){
        return {term:lterm,p:p1};
    }
    // deal with term kind
    if(token1.type=="comma" && termKind !="OrdinaryTerm"){
        return {term:lterm,p:p1};
    }
    if(token1.type =="ht_sep" && termKind =="ListElem"){
        return {term:lterm,p:p1};
    }
    // infixop
    let opinfo;
    if((opinfo=isInfixOp(token1)) 
    && (opinfo.priority<=MaxPriority) 
    && opinfo.lpriority>=lpriority){
        
        if(token1.type=="backquote"){
            let r1 = parse_backquoted_operator(p2,ps);
            let r2  = read(opinfo.rpriority,termKind,r1.p,ps);
            let backquoted_term = r1.term;
            if(nameArity(backquoted_term) == "./2"){
                backquoted_term.args[1]= backquotedapplyCompound(
                    backquoted_term.args[1].token,
                    [lterm,r2.term]
                )
                backquoted_term.startToken = backquoted_term.args[1].startToken;
                backquoted_term.endToken = backquoted_term.args[1].endToken;
                return bottom_up(MaxPriority,termKind,opinfo.priority,backquoted_term,r2.p,ps);
            }
            backquoted_term =   backquotedapplyCompound(backquoted_term.token,[lterm,r2.term]);
            return bottom_up(MaxPriority,termKind,opinfo.priority,backquoted_term,r2.p,ps);
        }
        //  name token
        let r  = read(opinfo.rpriority,termKind,p2,ps);
        let term =  infixCompound(token1,[lterm,r.term]);
        return bottom_up(MaxPriority,termKind,opinfo.priority,term,r.p,ps);
    }
    //    postfix  however mercury doesn't have opfix operator
    return {term:lterm,p:p1};

}
function imply(a:boolean,b:boolean){
    return !(a && (!b));
}

function isInfixOp(token:Token) {
    if(token.type =="backquote"){
        return {
            priority: 120,
            lpriority:120,
            rpriority:119
        };
    }
    else{
        let opinfo =  lookup_infix_op(token.value);
        if(!opinfo){
            return undefined;
        }
        let priority = opinfo.priority;
        let lpriority = adjust_priority_for_assoc(opinfo.priority,opinfo.lAssoc);
        let rpriority = adjust_priority_for_assoc(opinfo.priority,opinfo.rAssoc)
        return {
            priority,
            lpriority,
            rpriority
        }
    }
    return undefined;
}



function parse_backquoted_operator(p1:TokenIter,ps:ParserState) {
    let token1 = p1.val();
    let p2 = p1.next();
    switch (token1.type) {
        case "variable":{
            let term = variable(token1);
            add_var(term,ps);
            let token2 = p2.val();
            if(token2.type!="backquote"){
                errorToken("expect '`'",token2,ps);
                let r = skipUntil("backquote",p2.next(),ps);
                return {
                    term:term,
                    p:r.p
                }
            }
        }
        case "name":{
            let term = atom(token1);
            let nextp  = p2;
            forloop:
            for(;;){
                let nextToken = nextp.val();
                switch(nextToken.text){
                    case ".":{
                        let nextnextp = nextp.next();
                        let nextnextToken = nextnextp.val();
                        if(nextnextToken.type!="name"){
                            errorToken("expect name token",nextnextToken,ps);
                            let r = skipUntil("backquote",nextnextp,ps);
                            return {
                                term,
                                p:r.p
                            };
                        }
                        let r_term  = atom(nextnextToken);
                        term =  infixCompound(nextToken,[term,r_term]);
                        nextp = nextnextp.next();
                        continue forloop;
                    }
                    case "`":{
                        return {
                            term,
                            p:nextp.next()
                        };
                    }
                    // EOF
                    case "":{
                        return {
                            term,
                            p:nextp
                        }
                    }
                    default:{
                        errorToken("missing '.'",nextToken,ps);
                        let r = skipUntil("backquote",nextp.next(),ps);
                        return {
                            term,
                            p:r.p
                        }
                    }
                }
            }
        }
        default:{
            errorToken("missing name token",token1,ps);
            let term = atom(token1);
            let r = skipUntil("backquote",p1,ps);
            return{
                term,
                p:r.p
            }
        }
    }
}

function skipUntil(tokenType:TokenType, p1: TokenIter, ps: ParserState) {
    let tmp_p = p1;
    for(;;){
        let tmp_token = tmp_p.val();
        switch (tmp_token.type) {
            case "EOF":
                errorToken(`missing ${tokenType}`,tmp_token,ps);
                return {p:tmp_p} 
            case tokenType:
                return {p:tmp_p.next()}
            default:
                continue;
        }
    }
}

