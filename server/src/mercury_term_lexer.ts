// import {match,P} from "ts-pattern";
// type token=
// 	["name",string]
// 	|["variable",string]
// 	|["integer",integer_base,number,signedness,integer_size]
// 	|["float",number]
// 	|["string",string]
// 	|["implementation_defined",string]
// 	|"open"
// 	|"open_ct"
// 	|"close"
// 	|"open_list"
// 	|"close_list"
// 	|"open_curly"
// 	|"close_curly"
// 	|"ht_sep"
// 	|"comma"
// 	|"end"
// 	|["junk",string]
// 	|["error",string]
// 	|["io_error",Error]
// 	|"eof"
// 	|["integer_dot",number]

// type integer_base =
// 	"base_2"
// 	|"base_8"
// 	|"base_10"
// 	|"base_16"

// type signedness=
// 	"signed"
// 	|"unsigned"

// type integer_size =
// 	"size_word"
// 	|"size_8_bit"
// 	|"size_16_bit"
// 	|"size_32_bit"
// 	|"size_64_bit"

// type token_context = number 

// type token_list = 
// 	["token_cons",token,token_context,token_list]
// 	|"token_nil"

// type line_context = 
// 	["line_context",number,number]

// type line_posn=
// 	["line_posn",number]

// function get_token_list():token_list{
// 	stream = input_stream();
// 	return get_token_list_(stream);
// }

// function get_token_list_(stream:string):token_list{
// 	const [token,context]=get_token(stream);
// 	return get_token_list_2(stream,token,context);
// }

// type offset = number

// function get_token_list_2(stream:stream,token:token,token_context:token_context):token_list{
// 	let tokens:token_list="token_nil";
// 	match(token)
// 		.with("eof",()=>{tokens = "token_nil";})
// 		.with("end",["error",P._],["io_error",P._],()=>{tokens =["token_cons",token,token_context,"token_nil"];})
// 		.with(["integer_dot",P.select()],(integer)=>{
// 			const context1 = get_context(stream);
// 			const token1 = get_dot(stream);
// 			const tokens1 =get_token_list_2(stream,token1,context1);
// 			tokens = ["token_cons",["integer","base_10",integer,"signed","size_word"],token_context,tokens1];
// 		})
// 		.with(["float",P._],
// 			["string",P._],
// 			["variable",P._],
// 			["integer",P._,P._,P._,P._],
// 			["implementation_defined",P._],
// 			["junk",P._],
// 			["name",P._],
// 			"open",
// 			"open_ct",
// 			"close",
// 			"open_list",
// 			"close_list",
// 			"open_curly",
// 			"close_curly",
// 			"comma",
// 			"ht_sep",
// 			()=>{
// 				const [ token1,context1 ]= get_token_list(stream); 
// 				const tokens1=get_token_list_2(stream,token1,context1);
// 				tokens =["token_cons",token,token_context,tokens1];
// 			});

// 	return tokens;
// }

// function string_get_token_list_max(string:string,offset:offset,posn:posn):[token_list,posn] {
	
// }

// function linestr_get_token_list_max(string:string,offset:offset,line_context:line_context,line_posn:line_posn):[token_list,line_context,line_posn] {
	
// }

// function string_get_token_list(string:string,posn:posn):[token_list,posn] {
	
// }

// function token_to_string(token:token):string{

// }

// function graphic_token_char(char:char):boolean {
	
// }