export{opTable,max_priority ,OpInfo,Assoc}

type OpClass =
    Infix | Prefix | BinaryPrefix | Postfix
type Assoc = 'x' | 'y'
type Priority = number

type Infix = ["Infix", Assoc, Assoc]
type Prefix = ["Prefix", Assoc]
type BinaryPrefix = ["BinaryPrefix", Assoc, Assoc]
type Postfix = ["Postfix", Assoc, Assoc]
type OpInfo = [...OpClass, Priority]

let opTable: Map<string, OpInfo[]> = new Map([
    [
        "+",
        [["Infix", "y", "x", 500],
        ["Prefix", "x", 500]
        ]
    ],
    [
        "-", [
            ["Infix", "y", "x", 500],
            ["Prefix", "x", 200]
        ]
    ],
    [
        ":-", [
            ["Infix", 'x', 'x', 1200],
            ['Prefix', 'x', 1200]
        ]
    ],
    [
        "^", [
            ['Infix', "x", 'y', 99],
            ['Prefix', 'x', 100]
        ]
    ],
    // % The following operators are standard ISO Prolog.
    [","                               , [["Infix"        , "x" , "y"      , 1000 ]]] ,
    ["*"                               , [["Infix"        , "y" , "x"      , 400  ]]] ,
    ["**"                              , [["Infix"        , "x" , "y"      , 200  ]]] ,
    ["-->"                             , [["Infix"        , "x" , "x"      , 1200 ]]] ,
    ["->"                              , [["Infix"        , "x" , "y"      , 1050 ]]] ,
    ["/"                               , [["Infix"        , "y" , "x"      , 400  ]]] ,
    ["//"                              , [["Infix"        , "y" , "x"      , 400  ]]] ,
    ["/\\"                             , [["Infix"        , "y" , "x"      , 500  ]]] ,
    [";"                               , [["Infix"        , "x" , "y"      , 1100 ]]] ,
    ["<"                               , [["Infix"        , "x" , "x"      , 700  ]]] ,
    ["<<"                              , [["Infix"        , "y" , "x"      , 400  ]]] ,
    ["="                               , [["Infix"        , "x" , "x"      , 700  ]]] ,
    ["=.."                             , [["Infix"        , "x" , "x"      , 700  ]]] ,
    ["=:="                             , [["Infix"        , "x" , "x"      , 700  ]]] ,
    ["=<"                              , [["Infix"        , "x" , "x"      , 700  ]]] ,
    ["=="                              , [["Infix"        , "x" , "x"      , 700  ]]] ,
    ["=\\="                            , [["Infix"        , "x" , "x"      , 700  ]]] ,
    [">"                               , [["Infix"        , "x" , "x"      , 700  ]]] ,
    [">="                              , [["Infix"        , "x" , "x"      , 700  ]]] ,
    [">>"                              , [["Infix"        , "y" , "x"      , 400  ]]] ,
    ["?-"                              , [["Prefix"       , "x" ,            1200 ]]] ,
    ["@<"                              , [["Infix"        , "x" , "x"      , 700  ]]] ,
    ["@=<"                             , [["Infix"        , "x" , "x"      , 700  ]]] ,
    ["@>"                              , [["Infix"        , "x" , "x"      , 700  ]]] ,
    ["@>="                             , [["Infix"        , "x" , "x"      , 700  ]]] ,
    ["\\"                              , [["Prefix"       , "x" ,            200  ]]] ,
    ["\\+"                             , [["Prefix"       , "y" ,            900  ]]] ,
    ["\\/"                             , [["Infix"        , "y" , "x"      , 500  ]]] ,
    ["\\="                             , [["Infix"        , "x" , "x"      , 700  ]]] ,
    ["\\=="                            , [["Infix"        , "x" , "x"      , 700  ]]] ,
    ["div"                             , [["Infix"        , "y" , "x"      , 400  ]]] ,
    ["is"                              , [["Infix"        , "x" , "x"      , 701  ]]] ,
    ["mod"                             , [["Infix"        , "x" , "x"      , 400  ]]] ,
    ["rem"                             , [["Infix"        , "x" , "x"      , 400  ]]] ,
    // % The following operator is a Goedel extension
    ["~"                               , [["Prefix"       ,"y"  ,            900  ]]] ,
    // % The following operators are NU-Prolog extensions.
    ["~="                              , [["Infix"        ,"x"  ,"x"       , 700  ]]] ,
    ["and"                             , [["Infix"        ,"x"  ,"y"       , 720  ]]] ,
    ["or"                              , [["Infix"        ,"x"  ,"y"       , 740  ]]] ,
    ["rule"                            , [["Prefix"       ,"x"  ,            1199 ]]] ,
    ["when"                            , [["Infix"        ,"x"  ,"x"       , 900  ]]] ,
    ["where"                           , [["Infix"        ,"x"  ,"x"       , 1175 ]]] ,
// % The following operators are NU-Prolog extensions.
    ["<="                              , [["Infix"        ,"x"  ,"y"       , 920  ]]] ,
    ["<=>"                             , [["Infix"        ,"x"  ,"y"       , 920  ]]] ,
    ["=>"                              , [["Infix"        ,"x"  ,"y"       , 920  ]]] ,
    ["all"                             , [["BinaryPrefix" ,"x"  ,"y"       , 950  ]]] ,
    ["some"                            , [["BinaryPrefix" ,"x"  ,"y"       , 950  ]]] ,
    ["if"                              , [["Prefix"       ,"x"  ,            1160 ]]] ,
    ["then"                            , [["Infix"        ,"x"  ,"x"       , 1150 ]]] ,
    ["else"                            , [["Infix"        ,"x"  ,"y"       , 1170 ]]] ,
    ["catch"                           , [["Infix"        ,"x"  ,"y"       , 1180 ]]] ,
    ["catch_any"                       , [["Infix"        ,"x"  ,"y"       , 1190 ]]] ,
    ["not"                             , [["Prefix"       ,"y"  ,            900  ]]] ,
    ["pred"                            , [["Prefix"       ,"x"  ,            800  ]]] ,
// % The following operators are Mercury extensions.
    ["!"                               , [["Prefix"       ,"x"  ,            40   ]]] ,
    ["!."                              , [["Prefix"       ,"x"  ,            40   ]]] ,
    ["!:"                              , [["Prefix"       ,"x"  ,            40   ]]] ,
    ["&"                               , [["Infix"        , "x" ,"y"       , 1025 ]]] ,
    ["++"                              , [["Infix"        , "x" , "y"      , 500  ]]] ,
    ["--"                              , [["Infix"        , "y" , "x"      , 500  ]]] ,
    ["--->"                            , [["Infix"        , "x" , "y"      , 1179 ]]] ,
    ["."                               , [["Infix"        , "y" , "x"      , 10   ]]] ,
    [".."                              , [["Infix"        , "x" , "x"      , 550  ]]] ,
    [":"                               , [["Infix"        , "y" , "x"      , 120  ]]] ,
    ["::"                              , [["Infix"        , "x" , "x"      , 1175 ]]] ,
    [":="                              , [["Infix"        , "x" , "x"      , 650  ]]] ,
    ["==>"                             , [["Infix"        , "x" , "x"      , 1175 ]]] ,
    ["=^"                              , [["Infix"        , "x" , "x"      , 650  ]]] ,
    ["@"                               , [["Infix"        , "x" , "x"      , 90   ]]] ,
    ["end_module"                      , [["Prefix"       ,"x"  ,            1199 ]]] ,
    ["event"                           , [["Prefix"       ,"x"  ,            100  ]]] ,
    ["finalise"                        , [["Prefix"       ,"x"  ,            1199 ]]] ,
    ["finalize"                        , [["Prefix"       ,"x"  ,            1199 ]]] ,
    ["for"                             , [["Infix"        ,"x"  , "x"      , 500  ]]] ,
    ["func"                            , [["Prefix"       ,"x"  ,            800  ]]] ,
    ["import_module"                   , [["Prefix"       ,"x"  ,            1199 ]]] ,
    ["impure"                          , [["Prefix"       ,"y"  ,            800  ]]] ,
    ["include_module"                  , [["Prefix"       ,"x"  ,            1199 ]]] ,
    ["initialise"                      , [["Prefix"       ,"x"  ,            1199 ]]] ,
    ["initialize"                      , [["Prefix"       ,"x"  ,            1199 ]]] ,
    ["inst"                            , [["Prefix"       ,"x"  ,            1199 ]]] ,
    ["instance"                        , [["Prefix"       ,"x"  ,            1199 ]]] ,
    ["mode"                            , [["Prefix"       ,"x"  ,            1199 ]]] ,
    ["module"                          , [["Prefix"       ,"x"  ,            1199 ]]] ,
    ["or_else"                         , [["Infix"        , "x" , "y"      , 1100 ]]] ,
    ["pragma"                          , [["Prefix"       ,"x"  ,            1199 ]]] ,
    ["promise"                         , [["Prefix"       ,"x"  ,            1199 ]]] ,
    ["semipure"                        , [["Prefix"       ,"y"  ,            800  ]]] ,
    ["solver"                          , [["Prefix"       ,"y"  ,            1181 ]]] ,
    ["type"                            , [["Prefix"       ,"x"  ,            1180 ]]] ,
    ["typeclass"                       , [["Prefix"       ,"x"  ,            1199 ]]] ,
    ["use_module"                      , [["Prefix"       ,"x"  ,            1199 ]]] ,
    // BinaryPrefix  x y                                                     950
    ["arbitrary"                       , [["BinaryPrefix" ,"x"  ,"y"       , 950  ]]] ,
    ["disable_warning"                 , [["BinaryPrefix" ,"x"  ,"y"       , 950  ]]] ,
    ["disable_warnings"                , [["BinaryPrefix" ,"x"  ,"y"       , 950  ]]] ,
    ["promise_equivalent_solutions"    , [["BinaryPrefix" ,"x"  ,"y"       , 950  ]]] ,
    ["promise_equivalent_solution_sets", [["BinaryPrefix" ,"x"  ,"y"       , 950  ]]] ,
    ["require_complete_switch"         , [["BinaryPrefix" ,"x"  ,"y"       , 950  ]]] ,
    ["require_switch_arms_det"         , [["BinaryPrefix" ,"x"  ,"y"       , 950  ]]] ,
    ["require_switch_arms_semidet"     , [["BinaryPrefix" ,"x"  ,"y"       , 950  ]]] ,
    ["require_switch_arms_multi"       , [["BinaryPrefix" ,"x"  ,"y"       , 950  ]]] ,
    ["require_switch_arms_nondet"      , [["BinaryPrefix" ,"x"  ,"y"       , 950  ]]] ,
    ["require_switch_arms_cc_multi"    , [["BinaryPrefix" ,"x"  ,"y"       , 950  ]]] ,
    ["require_switch_arms_cc_nondet"   , [["BinaryPrefix" ,"x"  ,"y"       , 950  ]]] ,
    ["require_switch_arms_erroneous"   , [["BinaryPrefix" ,"x"  ,"y"       , 950  ]]] ,
    ["require_switch_arms_failure"     , [["BinaryPrefix" ,"x"  ,"y"       , 950  ]]] ,
    ["trace"                           , [["BinaryPrefix" ,"x"  ,"y"       , 950  ]]] ,
    ["atomic"                          , [["BinaryPrefix" ,"x"  ,"y"       , 950  ]]] ,
    ["try"                             , [["BinaryPrefix" ,"x"  ,"y"       , 950  ]]] ,

    // Prefix y                                                              950
    ["promise_exclusive"               , [["Prefix"       ,"y"  ,            950  ]]] ,
    ["promise_exhaustive"              , [["Prefix"       ,"y"  ,            950  ]]] ,
    ["promise_exclusive_exhaustive"    , [["Prefix"       ,"y"  ,            950  ]]] ,
    // Prefix x                                                              950
    ["promise_pure"                    , [["Prefix"       ,"x"  ,            950  ]]] ,
    ["promise_semipure"                , [["Prefix"       ,"x"  ,            950  ]]] ,
    ["promise_impure"                  , [["Prefix"       ,"x"  ,            950  ]]] ,
    ["require_det"                     , [["Prefix"       ,"x"  ,            950  ]]] ,
    ["require_semidet"                 , [["Prefix"       ,"x"  ,            950  ]]] ,
    ["require_multi"                   , [["Prefix"       ,"x"  ,            950  ]]] ,
    ["require_nondet"                  , [["Prefix"       ,"x"  ,            950  ]]] ,
    ["require_cc_multi"                , [["Prefix"       ,"x"  ,            950  ]]] ,
    ["require_cc_nondet"               , [["Prefix"       ,"x"  ,            950  ]]] ,
    ["require_erroneous"               , [["Prefix"       ,"x"  ,            950  ]]] ,
    ["require_failure"                 , [["Prefix"       ,"x"  ,            950  ]]]
])

export function lookup_infix_op(s:string){
    let infos = opTable.get(s);
    if(!infos) return undefined;
    for (const info of infos) {
        if (isInfix(info)){
            return{
                lAssoc:info[1],
                rAssoc:info[2],
                priority:info[3]
            }
        }
    }
}
function isInfix(params:OpInfo):params is [...Infix,Priority]{
    return params[0]=="Infix"
}
function lookupPrefixOp(s:string) {
    let infos = opTable.get(s);
    if(!infos) return undefined;
    for (const info of infos) {
        if (isPrefix(info)){
            return{
                lAssoc:info[1],
                priority:info[2]
            }
        }
    }
}
function isPrefix(params:OpInfo):params is [...Prefix,Priority]{
    return params[0]=="Prefix"
}
function lookupBinaryPrefixOp(s:string) {
    let infos = opTable.get(s);
    if(!infos) return false;
    for (const info of infos) {
        if (isBinaryPrefix(info)){
            return{
                lAssoc:info[1],
                rAssoc:info[2],
                priority:info[3]
            }
        }
    }
}
function isBinaryPrefix(params:OpInfo):params is [...BinaryPrefix,Priority]{
    return params[0]=="BinaryPrefix"
}

function lookupPostfixOp(s:string) {
    let infos = opTable.get(s);
    if(!infos) return false;
    for (const info of infos) {
        if (isPostfix(info)){
            return{
                lAssoc:info[1],
                priority:info[2]
            }
        }
    }
}
function isPostfix(params:OpInfo):params is [...Postfix,Priority]{
    return params[0]=="BinaryPrefix"
}

export function lookup_op(s:string) {
    return opTable.get(s)
    ?	true
    :	false
}
export function lookup_op_infos(s:string) {
    return opTable.get(s)
}
export function lookup_operator_term(){
    return {
        priority:120,
        lAssoc:<Assoc>"y",
        rAssoc:<Assoc>"x"
    }
}
export function adjust_priority_for_assoc(priority:Priority,assoc:Assoc) {
    if(assoc =="y")
        return priority
    else// if(assoc =="x")
        return priority-1;
}
const max_priority = 1200;
const argPriority = 999;
