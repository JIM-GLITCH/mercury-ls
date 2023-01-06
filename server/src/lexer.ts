import * as moo from "moo"
export{ lexer ,Token,TokenList}
type TokenType=
     "end"
    |"line_number_directive"
    |"comment"
    |"string"
    |"name"
    |"variable"
    |"integer"
    |"float"
    |"error"
    |"junk"
    |"comma"
    |"ht_sep"
    |"close_curly"
    |"open_curly"
    |"close_list"
    |"open_list"
    |"close"
    |"open"
    |"open_ct"
    |"implementation_defined"

interface Token extends moo.Token{
    type:TokenType
}
const moolexer = moo.compile({
    end: {
        /**
             EOF  $(?![\r\n])
         */
        match: /\.(?=\s|$(?![\r\n])|%)/
    },
    line_number_directive: /#[1-9][0-9]*/,
    comment: [
        // block comment
        // match any character [\s\S]
        { match: /\/\*[\s\S]*?\*\//, lineBreaks: true },
        // line comment
        { match: /%.*/ }
    ]

    ,
    string: {
        match: /"(?:""|\\(?:.|\n)|(?!").)*"/, lineBreaks: true
    },
    name: [
        { match: /[a-z][_0-9a-zA-Z]*/ },
        { match: /'(?:''|\\(?:.|\n)|(?!').)*'/, lineBreaks: true },
        { match: /[#$&*+\-./:<=>?@^~\\]+/ },
    ],
    variable: [
        { match: /[_A-Z][_0-9a-zA-Z]*/ },
    ],
    integer: [
        /**
             For decimal, binary, octal and hexadecimal literals, an arbitrary number of
            underscores (‘_’) may be inserted between the digits. An arbitrary number of
            underscores may also be inserted between the radix prefix (i.e. ‘0b’, ‘0o’ and
            ‘0x’) and the initial digit. Similarly, an arbitrary number of underscores may
            be inserted between the final digit and the signedness suffix. The purpose of
            the underscores is to improve readability, and they do not affect the numeric
            value of the literal.
            
            an arbitrary number of underscores (‘_’) may be inserted between the digits.
                decimal         [0-9](?:[0-9_]*[0-9])?
                binary          [01](?:[01_]*[01])?
                octal           [0-7](?:[0-7_]*[0-7])?

            An arbitrary number ofunderscores may also be inserted between the radix prefix 
            (i.e. ‘0b’, ‘0o’ and‘0x’) and the initial digit.
                binary          0b_*
                octal           0o_*
                hexadecimal     0x_*

            an arbitrary number of underscores may be inserted between the final digit and
            the signedness suffix.
                _*(?:i(?:8|16|32|64)?|u(?:8|16|32|64)?)
                or
                _*(?:i8|i16|i32|i64|i|u8|u16|u32|u64|u)
         */

        // decimal 
        { match: /[0-9](?:[0-9_]*[0-9])?(?:_*(?:i8|i16|i32|i64|i|u8|u16|u32|u64|u))?/ },
        // binary
        { match: /0b_*[01](?:[01_]*[01])?(?:_*(?:i8|i16|i32|i64|i|u8|u16|u32|u64|u))?/ },
        // octal
        { match: /0o_*[0-7]+(?:_*(?:i8|i16|i32|i64|i|u8|u16|u32|u64|u))?/ },
        // hexadecimal
        { match: /0x_*[0-9A-Fa-f]+(?:_*(?:i8|i16|i32|i64|i|u8|u16|u32|u64|u))?/ },
        // character-code literal 
        { match: /0'(?:""|\\(?:[abrftnv\\'"]|x[0-9A-Fa-f]+\\|[0-7][0-7]*\\|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})|.)/ },
    ],
    float: {
        /* 	
            decimal digits part     [0-9](?:[0-9_]*[0-9])? 
                An arbitrary number of underscores (‘_’) may be inserted between the digits in
                a floating point literal. Underscores may not occur adjacent to any non-digit
                characters (i.e. ‘.’, ‘e’, ‘E’, ‘+’ or ‘-’) in a floating point literal. 
             
            fraction part           \.[0-9](?:[0-9_ ]*[0-9])?

            exponent part           [eE][+-]?[0-9](?:[0-9_]*[0-9])?

            The fraction part or the exponent (but not both) may be omitted.
                                                    
        */
        match: /[0-9](?:[0-9_]*[0-9])?(?:\.[0-9](?:[0-9_]*[0-9])?(?:[eE][+-]?[0-9](?:[0-9_]*[0-9])?)?|[eE][+-]?[0-9](?:[0-9_]*[0-9])?)/
    },
    implementation_defined: {
        match: /\$[a-z][_0-9a-zA-Z]*/
    },
    open_ct: {
        /**
            A left parenthesis, ‘(’, that is not preceded by whitespace

            not preceded by whitespace        (?<!\s)
         */
        match: /(?<!\s)\(/
    },
    open: "(",
    close: ")",
    open_list: "[",
    close_list: "]",
    open_curly: "{",
    close_curly: "}",
    ht_sep: "|",
    comma: ",",
    junk: { match: /\s+/, lineBreaks: true },
    error: /./,
})

interface Lexer extends moo.Lexer {
    getTokens(): TokenList
    clone(): Lexer
    next():Token|undefined
    [Symbol.iterator](): Iterator<Token>;
}

type TokenList = {
    tokens: Token[],
    end: Token | undefined,
    errors: Token[]
}

let lexer = moolexer as Lexer

let MyLexerPrototype = lexer.constructor.prototype
MyLexerPrototype.getTokens = function () {
    let tokenList: TokenList = { tokens: [], end: undefined, errors: [] }
    let tokens = tokenList.tokens
    let errors = tokenList.errors
    for (;;){
        let token = (this as Lexer).next();
        // 遇到 end of file
        if(!token){
            if(tokens.length>0)
                return tokenList;
            break;
        }

        switch (token.type) {
            // 遇到空格token 注释token 跳过
            case "junk":
            case "comment":
                continue
            // 遇到 error 收集错误
            case "error":
                errors.push(token);
                continue
            // 遇到 end of clause 返回 tokenlist
            case "end":
                tokenList.end = token;
                return tokenList;
            // 遇到一般 token 添加到tokens里
            default:
                tokens.push(token)
        }
    }
}