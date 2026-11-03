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

// Mercury operator table (library/ops.m).
// NOTE: In the current Mercury convention HIGHER priority binds TIGHTER
// (priority 1500 = tightest, 1 = loosest). The values below are the
// authoritative ones from ops.m; assoc 'y' = arg_ge (same-or-tighter
// operand allowed), 'x' = arg_gt (operand must be strictly tighter).
let opTable: Map<string, OpInfo[]> = new Map([
    [
        "+",
        [["Infix", "y", "x", 1000],
        ["Prefix", "x", 1000]
        ]
    ],
    [
        "-", [
            ["Infix", "y", "x", 1000],
            ["Prefix", "x", 1300]
        ]
    ],
    [
        ":-", [
            ["Infix", 'x', 'x', 300],
            ['Prefix', 'x', 300]
        ]
    ],
    [
        "^", [
            ['Infix', "x", 'y', 1401],
            ['Prefix', 'x', 1400]
        ]
    ],
    // % The following operators are standard ISO Prolog.
    [","                               , [["Infix"        , "x" , "y"      , 500 ]]] ,
    ["*"                               , [["Infix"        , "y" , "x"      , 1100 ]]] ,
    ["**"                              , [["Infix"        , "x" , "y"      , 1300 ]]] ,
    ["-->"                             , [["Infix"        , "x" , "x"      , 300 ]]] ,
    ["->"                              , [["Infix"        , "x" , "y"      , 450 ]]] ,
    ["/"                               , [["Infix"        , "y" , "x"      , 1100 ]]] ,
    ["//"                              , [["Infix"        , "y" , "x"      , 1100 ]]] ,
    ["/\\"                             , [["Infix"        , "y" , "x"      , 1000 ]]] ,
    [";"                               , [["Infix"        , "x" , "y"      , 400 ]]] ,
    ["<"                               , [["Infix"        , "x" , "x"      , 800 ]]] ,
    ["<<"                              , [["Infix"        , "y" , "x"      , 1100 ]]] ,
    ["="                               , [["Infix"        , "x" , "x"      , 800 ]]] ,
    ["=.."                             , [["Infix"        , "x" , "x"      , 800 ]]] ,
    ["=:="                             , [["Infix"        , "x" , "x"      , 800 ]]] ,
    ["=<"                              , [["Infix"        , "x" , "x"      , 800 ]]] ,
    ["=="                              , [["Infix"        , "x" , "x"      , 800 ]]] ,
    ["=\\="                            , [["Infix"        , "x" , "x"      , 800 ]]] ,
    [">"                               , [["Infix"        , "x" , "x"      , 800 ]]] ,
    [">="                              , [["Infix"        , "x" , "x"      , 800 ]]] ,
    [">>"                              , [["Infix"        , "y" , "x"      , 1100 ]]] ,
    ["<<u"                             , [["Infix"        , "y" , "x"      , 1100 ]]] ,
    [">>u"                             , [["Infix"        , "y" , "x"      , 1100 ]]] ,
    ["?-"                              , [["Prefix"       , "x" ,            300 ]]] ,
    ["@<"                              , [["Infix"        , "x" , "x"      , 800 ]]] ,
    ["@=<"                             , [["Infix"        , "x" , "x"      , 800 ]]] ,
    ["@>"                              , [["Infix"        , "x" , "x"      , 800 ]]] ,
    ["@>="                             , [["Infix"        , "x" , "x"      , 800 ]]] ,
    ["\\"                              , [["Prefix"       , "x" ,            1300 ]]] ,
    ["\\+"                             , [["Prefix"       , "y" ,            600 ]]] ,
    ["\\/"                             , [["Infix"        , "y" , "x"      , 1000 ]]] ,
    ["\\="                             , [["Infix"        , "x" , "x"      , 800 ]]] ,
    ["\\=="                            , [["Infix"        , "x" , "x"      , 800 ]]] ,
    ["div"                             , [["Infix"        , "y" , "x"      , 1100 ]]] ,
    ["is"                              , [["Infix"        , "x" , "x"      , 799 ]]] ,
    ["mod"                             , [["Infix"        , "x" , "x"      , 1100 ]]] ,
    ["rem"                             , [["Infix"        , "x" , "x"      , 1100 ]]] ,
    // % The following operator is a Goedel extension
    ["~"                               , [["Prefix"       ,"y"  ,            600 ]]] ,
    // % The following operators are NU-Prolog extensions.
    ["~="                              , [["Infix"        ,"x"  ,"x"       , 800 ]]] ,
    ["and"                             , [["Infix"        ,"x"  ,"y"       , 780 ]]] ,
    ["or"                              , [["Infix"        ,"x"  ,"y"       , 760 ]]] ,
    ["rule"                            , [["Prefix"       ,"x"  ,            301 ]]] ,
    ["when"                            , [["Infix"        ,"x"  ,"x"       , 600 ]]] ,
    ["where"                           , [["Infix"        ,"x"  ,"x"       , 325 ]]] ,
// % The following operators are NU-Prolog extensions.
    ["<="                              , [["Infix"        ,"x"  ,"y"       , 580 ]]] ,
    ["<=>"                             , [["Infix"        ,"x"  ,"y"       , 580 ]]] ,
    ["=>"                              , [["Infix"        ,"x"  ,"y"       , 580 ]]] ,
    ["all"                             , [["BinaryPrefix" ,"x"  ,"y"       , 550 ]]] ,
    ["some"                            , [["BinaryPrefix" ,"x"  ,"y"       , 550 ]]] ,
    ["if"                              , [["Prefix"       ,"x"  ,            340 ]]] ,
    ["then"                            , [["Infix"        ,"x"  ,"x"       , 350 ]]] ,
    ["else"                            , [["Infix"        ,"x"  ,"y"       , 330 ]]] ,
    ["catch"                           , [["Infix"        ,"x"  ,"y"       , 320 ]]] ,
    ["catch_any"                       , [["Infix"        ,"x"  ,"y"       , 310 ]]] ,
    ["not"                             , [["Prefix"       ,"y"  ,            600 ]]] ,
    ["pred"                            , [["Prefix"       ,"x"  ,            700 ]]] ,
// % The following operators are Mercury extensions.
    ["!"                               , [["Prefix"       ,"x"  ,            1460 ]]] ,
    ["!."                              , [["Prefix"       ,"x"  ,            1460 ]]] ,
    ["!:"                              , [["Prefix"       ,"x"  ,            1460 ]]] ,
    ["&"                               , [["Infix"        , "x" ,"y"       , 475 ]]] ,
    ["++"                              , [["Infix"        , "x" , "y"      , 1000 ]]] ,
    ["--"                              , [["Infix"        , "y" , "x"      , 1000 ]]] ,
    ["--->"                            , [["Infix"        , "x" , "y"      , 321 ]]] ,
    ["."                               , [["Infix"        , "y" , "x"      , 1490 ]]] ,
    [".."                              , [["Infix"        , "x" , "x"      , 950 ]]] ,
    [":"                               , [["Infix"        , "y" , "x"      , 1380 ]]] ,
    ["::"                              , [["Infix"        , "x" , "x"      , 325 ]]] ,
    [":="                              , [["Infix"        , "x" , "x"      , 850 ]]] ,
    ["==>"                             , [["Infix"        , "x" , "x"      , 325 ]]] ,
    ["=^"                              , [["Infix"        , "x" , "x"      , 850 ]]] ,
    ["@"                               , [["Infix"        , "x" , "x"      , 1410 ]]] ,
    ["end_module"                      , [["Prefix"       ,"x"  ,            301 ]]] ,
    ["event"                           , [["Prefix"       ,"x"  ,            1400 ]]] ,
    ["finalise"                        , [["Prefix"       ,"x"  ,            301 ]]] ,
    ["finalize"                        , [["Prefix"       ,"x"  ,            301 ]]] ,
    ["for"                             , [["Infix"        ,"x"  , "x"      , 1000 ]]] ,
    ["func"                            , [["Prefix"       ,"x"  ,            700 ]]] ,
    ["import_module"                   , [["Prefix"       ,"x"  ,            301 ]]] ,
    ["impure"                          , [["Prefix"       ,"y"  ,            700 ]]] ,
    ["include_module"                  , [["Prefix"       ,"x"  ,            301 ]]] ,
    ["initialise"                      , [["Prefix"       ,"x"  ,            301 ]]] ,
    ["initialize"                      , [["Prefix"       ,"x"  ,            301 ]]] ,
    ["inst"                            , [["Prefix"       ,"x"  ,            301 ]]] ,
    ["instance"                        , [["Prefix"       ,"x"  ,            301 ]]] ,
    ["mode"                            , [["Prefix"       ,"x"  ,            301 ]]] ,
    ["module"                          , [["Prefix"       ,"x"  ,            301 ]]] ,
    ["or_else"                         , [["Infix"        , "x" , "y"      , 400 ]]] ,
    ["pragma"                          , [["Prefix"       ,"x"  ,            301 ]]] ,
    ["promise"                         , [["Prefix"       ,"x"  ,            301 ]]] ,
    ["semipure"                        , [["Prefix"       ,"y"  ,            700 ]]] ,
    ["solver"                          , [["Prefix"       ,"y"  ,            319 ]]] ,
    ["type"                            , [["Prefix"       ,"x"  ,            320 ]]] ,
    ["typeclass"                       , [["Prefix"       ,"x"  ,            301 ]]] ,
    ["use_module"                      , [["Prefix"       ,"x"  ,            301 ]]] ,
    // BinaryPrefix  x y                                                     550
    ["arbitrary"                       , [["BinaryPrefix" ,"x"  ,"y"       , 550 ]]] ,
    ["disable_warning"                 , [["BinaryPrefix" ,"x"  ,"y"       , 550 ]]] ,
    ["disable_warnings"                , [["BinaryPrefix" ,"x"  ,"y"       , 550 ]]] ,
    ["promise_equivalent_solutions"    , [["BinaryPrefix" ,"x"  ,"y"       , 550 ]]] ,
    ["promise_equivalent_solution_sets", [["BinaryPrefix" ,"x"  ,"y"       , 550 ]]] ,
    ["require_complete_switch"         , [["BinaryPrefix" ,"x"  ,"y"       , 550 ]]] ,
    ["require_switch_arms_det"         , [["BinaryPrefix" ,"x"  ,"y"       , 550 ]]] ,
    ["require_switch_arms_semidet"     , [["BinaryPrefix" ,"x"  ,"y"       , 550 ]]] ,
    ["require_switch_arms_multi"       , [["BinaryPrefix" ,"x"  ,"y"       , 550 ]]] ,
    ["require_switch_arms_nondet"      , [["BinaryPrefix" ,"x"  ,"y"       , 550 ]]] ,
    ["require_switch_arms_cc_multi"    , [["BinaryPrefix" ,"x"  ,"y"       , 550 ]]] ,
    ["require_switch_arms_cc_nondet"   , [["BinaryPrefix" ,"x"  ,"y"       , 550 ]]] ,
    ["require_switch_arms_erroneous"   , [["BinaryPrefix" ,"x"  ,"y"       , 550 ]]] ,
    ["require_switch_arms_failure"     , [["BinaryPrefix" ,"x"  ,"y"       , 550 ]]] ,
    ["trace"                           , [["BinaryPrefix" ,"x"  ,"y"       , 550 ]]] ,
    ["atomic"                          , [["BinaryPrefix" ,"x"  ,"y"       , 550 ]]] ,
    ["try"                             , [["BinaryPrefix" ,"x"  ,"y"       , 550 ]]] ,

    // Prefix y                                                              550
    ["promise_exclusive"               , [["Prefix"       ,"y"  ,            550 ]]] ,
    ["promise_exhaustive"              , [["Prefix"       ,"y"  ,            550 ]]] ,
    ["promise_exclusive_exhaustive"    , [["Prefix"       ,"y"  ,            550 ]]] ,
    // Prefix x                                                              550
    ["promise_pure"                    , [["Prefix"       ,"x"  ,            550 ]]] ,
    ["promise_semipure"                , [["Prefix"       ,"x"  ,            550 ]]] ,
    ["promise_impure"                  , [["Prefix"       ,"x"  ,            550 ]]] ,
    ["require_det"                     , [["Prefix"       ,"x"  ,            550 ]]] ,
    ["require_semidet"                 , [["Prefix"       ,"x"  ,            550 ]]] ,
    ["require_multi"                   , [["Prefix"       ,"x"  ,            550 ]]] ,
    ["require_nondet"                  , [["Prefix"       ,"x"  ,            550 ]]] ,
    ["require_cc_multi"                , [["Prefix"       ,"x"  ,            550 ]]] ,
    ["require_cc_nondet"               , [["Prefix"       ,"x"  ,            550 ]]] ,
    ["require_erroneous"               , [["Prefix"       ,"x"  ,            550 ]]] ,
    ["require_failure"                 , [["Prefix"       ,"x"  ,            550 ]]]
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
        priority:1380,
        lAssoc:<Assoc>"y",
        rAssoc:<Assoc>"x"
    }
}
// In the current convention (higher priority binds tighter), 'y' allows an
// operand of the same-or-tighter precedence (arg_ge, no change), while 'x'
// requires a strictly tighter operand (arg_gt, +1).
export function adjust_priority_for_assoc(priority:Priority,assoc:Assoc) {
    if(assoc =="y")
        return priority
    else// if(assoc =="x")
        return priority+1;
}
const max_priority = 1500;
const argPriority = 501;
