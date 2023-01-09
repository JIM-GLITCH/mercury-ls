// type term = functor|variable

import { Token } from './lexer'

export type Term =
	variable|atom|integer|str|float|negInteger|negFloat|implementation_defined|binPrefixCompound|prefixCompound|functorCompound

export class variable{
	token
	constructor(token:Token){
		this.token=token
	}
}

export class atom{
	token: Token
	val:string
	constructor(token:Token,val:string=token.value){
		this.token=token;
		this.val = val;

	}

}
export class integer{
	token: Token
	constructor(token:Token,){
		this.token=token;
	}
}
export class str{
	token: Token
	constructor(token:Token,){
		this.token=token;
	}
}
export class float {
	token: Token
	constructor(token:Token,){
		this.token=token;
	}
}

export class negInteger{
	sign:Token
	token: Token
	constructor(token:Token,sign:Token){
		this.token=token;
		this.sign = sign;
	}
}
export class negFloat{
	sign:Token
	token: Token
	constructor(token:Token,sign:Token){
		this.token=token;
		this.sign = sign;
	}
}
export class implementation_defined{
	token: Token
	constructor(token:Token,){
		this.token=token;
	}
}
export class binPrefixCompound{
	token: Token
	childern:Term[]
	constructor(token:Token,childern:Term[]){
		this.token=token;
		this.childern = childern;
	}
}

export class prefixCompound{
	token: Token
	childern:Term[]
	constructor(token:Token,childern:Term[]){
		this.token=token;
		this.childern = childern;
	}
}


export class functorCompound{
	token: Token
	val:string
	childern:Term[]
	constructor(token:Token,childern:Term[],val:string=token.value){
		this.token=token;
		this.childern = childern;
		this.val=val;
	}
}

export class applyTerm{
	token:Token
	val = "";
	childern
	constructor(token:Token,childern:Term[]){
		this.token=token;
		this.childern = childern;
	}
}

export class infixCompound{
	token: Token
	val:string
	childern:Term[]
	constructor(token:Token,childern:Term[],val:string=token.value){
		this.token=token;
		this.childern = childern;
		this.val=val;
	}
}