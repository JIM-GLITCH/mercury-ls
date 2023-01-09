import { lexer } from './lexer';
lexer.reset(`
%---------------------------------------------------------------------------%

    % read_term(Result, !IO):
    % read_term(Stream, Result, !IO):
    %
    % Reads a Mercury term from the current input stream or from Stream.
    %
:- pred read_term(read_term(T)::out, io::di, io::uo) is det
:- pred read_term(io.text_input_stream::in, read_term(T)::out,
    io::di, io::uo) is det.
`)
let tokenlist = lexer.getTokenList();
console.log(tokenlist);
console.log(tokenlist);
