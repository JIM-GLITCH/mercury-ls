import { CancellationToken, Diagnostic, DiagnosticSeverity } from 'vscode-languageserver'
import { MercuryDocument } from './document-manager'
import { MultiMap } from './multimap'
import { TreeStreamImpl, stream } from './stream'
import { Clause, RootNode, Term, termRange } from './term'
import { sameArity } from './utils'
import { interruptAndCheck } from './promise-util'
export interface Vistor {
    visit(doc: MercuryDocument, cancelToken: CancellationToken): void
}
export type VisitResult = {
    module?:Term
    errors:Diagnostic[]
    definition: MultiMap<string,Term>,
    reference:MultiMap<string,Term>,
    declaration:MultiMap<string,Term>,
    exports:MultiMap<string,Term>
    imports:Term[]
}
export class Visitor {
    module?:Term
    imports=[] as Term[]
    section?:string  
    currentClause!: Clause
    errors: Diagnostic[] = []
    definition = new MultiMap<string, Term>()
    reference = new MultiMap<string, Term>()
    declaration = new MultiMap<string, Term>()
    export= new MultiMap<string, Term>()
    async visit(doc: MercuryDocument, cancelToken: CancellationToken) {
        let rootNode = doc.parseResult.value
        for (const clause of rootNode.args) {
            interruptAndCheck(cancelToken)
            this.visitClause(clause)
        }
        doc.visitResult = {
            module:this.module,
            errors:this.errors,
            definition:this.definition,
            reference:this.reference,
            declaration:this.declaration,
            exports:this.export,
            imports:this.imports
        }
    }
    visitClause(clause: Clause) {
        this.currentClause = clause
        let topTerm = clause.term
        switch (topTerm.nameArity) {
            case ":-/1":
                // declaration : ':-'(Decl)
                this.visitDecl(topTerm.args[0])
                break
            // rule : ':-'(RuleHead,RuleBody)
            case ":-/2":
                this.visitRuleHead(topTerm.args[0])
                this.visitRuleBody(topTerm.args[1])
                break
            case "=/2":
                // func_fact ：'='(Func,FuncReturn)
                this.visitFuncRuleHead(topTerm)
                break
            case "-->/2":
                // dcg : '-->'(DcgHead,DcgBody)
                this.visitDcgHead(topTerm.args[0])
                this.visitDcgBody(topTerm.args[1])
                break
            default:
                //  pred_fact : PredFact
                this.visitPredDef(topTerm)
                break
        }
    }
    visitDcgHead(term: Term) {
        this.DcgFixArity(term)
        this.visitPredDef(term)
        this.addDefinition(term)
    }
    visitDcgBody(term: Term) {
        switch (term.nameArity) {
            case "some/2":
            case "all/2": {
                this.visitDcgBody(term.args[1])
                break
            }
            case ",/2":
            // case "&/2":
            case ";/2":
                {
                    this.visitDcgBody(term.args[0])
                    this.visitDcgBody(term.args[1])
                    break
                }
            case '{}/1': {
                this.visitRuleBody(term.args[0])
                break
            }
            // case "[|]/2":
            // case "[]/0":
            // case "true":
            // case "fail":
            case "not/1":
            case "\\+/1":
                {
                    this.visitDcgBody(term.args[0])
                    break
                }
            // case "=>/2":
            // case "<=/2":
            // case "<=>/2":
            case "else/2": {
                this.visitDcgBody(term.args[0])
                this.visitDcgBody(term.args[1])
                break
            }

            case "if/1": {
                this.visitDcgBody(term.args[0])
                break
            }
            case "then/2":
            case "->/2":
                // case "=/2":
                // case "\\=/2":
                {
                    this.visitDcgBody(term.args[0])
                    this.visitDcgBody(term.args[1])
                    break
                }
            case "=/1":
            case ":=/1": {
                this.visitDataTerm(term.args[0])
                break
            }
            case "=^/2":{
                this.visitDataTerm(term.args[0]);
                this.visitFieldList(term.args[1]);
                break;
            }
            case ":=/2": {
                if(nameArity(term.args[0],"^/1")){
                    this.visitFieldList(term.args[0].args[0])
                }
                this.visitDataTerm(term.args[1])
                break
            }
            case "^/1": {
                this.visitRuleBody(term.args[0])
                break

            }
            default:
                this.DcgFixArity(term);
                this.visitPredRef(term)
        }
    }
    visitFieldList(term: Term) {
        if(nameArity(term,"^/2")){
            this.visitField(term.args[0])
            this.visitField(term.args[1])
        }else{
            this.visitField(term)
        }
    }
    visitField(term: Term) {
        fieldTransform(term);
        label(term,"pred")
    }
    visitDataTerm(term: Term) {
        if(isVariable(term)){
            this.visitVariable(term);
        }else if(isSpecialDataTerm(term)){
            this.visitSpecialDataTerm(term)
        }else {
            this.visitDataFunctor(term);
        }
    }
    visitDataFunctor(term: Term) {
        switch(term.syntaxType){
            case 'integer':
                this.visitInteger(term)
                break;
            case 'float':
                this.visitFloat(term)
            case 'string':
                this.visitString(term)
                break;
            case 'atom':
                this.visitFuncOrPredOrConstr(term)
                break;
            case 'implementation_defined':
                this.visitImplementationDefined(term)

        }
    }
    visitImplementationDefined(term: Term) {
        throw new Error('Method not implemented.')
    }
    visitFuncOrPredOrConstr(term: Term) {
        this.addReference(term)
    }
    visitFloat(term: Term) {
        label(term,"float")
    }
    visitInteger(term: Term) {
        label(term,"integer")
    }
    visitSpecialDataTerm(term: Term) {
        // switch (term.semanticType as SpecialDataTerm){
        //     case 'conditional':
        //         this.visitRuleBody(term.args[0])
        //         this.visitRuleBody(term.args[1])
        //         break
        //     case 'record':
        //         this.visitRecord(term)
        //         break
        //     case 'apply':
        //         this.visitApply(term)
        //         break
        //     case 'lambda':
        //         this.visitLambda(term);
        //         break
        //     case 'unification':
        //         this.visitUnification(term)
        //         break
        //     case 'explicitType':
        //         this.visitExpliciType(term)
        // }
    }
    visitExpliciType(term: Term) {
        this.visitDataFunctor(term.args[0])
        this.visitTypeName(term.args[1])
    }
    visitUnification(term: Term) {
        // 
    }
    visitLambda(term: Term) {
        label(term, "lambda")
    }
    visitApply(term: Term) {
        label(term,"apply");
        
    }
    visitRecord(term: Term) {
        if(nameArity(term,"^/2")){
            this.visitDataTerm(term.args[0])
            this.visitFieldList(term.args[1])
        }else{
            this.visitDataTerm(term)
        }
    }
    visitString(term: Term) {
        label(term,"string")
    }

    DcgFixArity(term: Term) {
        term.arity += 2
        updateNameArity(term)
    }
    visitRuleHead(term: Term) {
        if (nameArity(term, '=/2')) {
            this.visitFuncRuleHead(term)
        } else {
            this.visitPredDef(term)
            this.addDefinition(term)
        }
    }
    visitPredDef(term: Term) {
        label(term,"pred")
        this.addDefinition(term)
        this.currentClause.callee = term
    }
    visitRuleBody(term: Term) {
        switch (term.nameArity) {
            case "some/2":
            case "all/2": {
                this.visitRuleBody(term.args[1])
                break
            }
            case ",/2":
            case "&/2":
            case ";/2":
                {
                    this.visitRuleBody(term.args[0])
                    this.visitRuleBody(term.args[1])
                    break
                }

            case "true":
            case "fail":
                {
                    break
                }
            case "not/1":
            case "\\+/1":
                {
                    this.visitRuleBody(term.args[0])
                    break
                }
            case "=>/2":
            case "<=/2":
            case "<=>/2":
            case "else/2": {
                this.visitRuleBody(term.args[0])
                this.visitRuleBody(term.args[1])
                break
            }

            case "if/1": {
                this.visitRuleBody(term.args[0])
                break
            }
            case "then/2":{
                this.visitRuleBody(term.args[0])
                this.visitRuleBody(term.args[1])
                break
            }
            case "->/2":
                this.visitRuleBody(term.args[0])
                this.visitRuleBody(term.args[1])
                break
            case "=/2":
            case "\\=/2": {
                this.visitDataTerm(term.args[0])
                this.visitDataTerm(term.args[1])
                break
            }
            /** 
             * TODO:
             * call/N
             * Var/N
             */
            case "promise_pure/1":
            case "promise_semipure/1":
            case "promise_impure/1": {
                this.visitRuleBody(term.args[0])
                break
            }
            case "promise_equivalent_solutions/2":
            case "promise_equivalent_solution_sets/2": {
                this.visitRuleBody(term.args[1])
                break
            }


            case "require_det/1":
            case "require_semidet/1":
            case "require_multi/1":
            case "require_nondet/1":
            case "require_cc_multi/1":
            case "require_cc_nondet/1":
            case "require_erroneous/1":
            case "require_failure/1": {
                this.visitRuleBody(term.args[0])
                break
            }

            case "require_complete_switch/2":

            case "require_switch_arms_det/2":
            case "require_switch_arms_semidet/2":
            case "require_switch_arms_multi/2":
            case "require_switch_arms_nondet/2":
            case "require_switch_arms_cc_multi/2":
            case "require_switch_arms_cc_nondet/2":
            case "require_switch_arms_erroneous/2":
            case "require_switch_arms_failure/2":

            case "disable_warnings/2":
            case "disable_warning/2":
            case "trace/2": {
                this.visitRuleBody(term.args[1])
                break
            }

            case "catch_any/2":
            case "catch/2":
            case "try/2": {
                this.visitRuleBody(term.args[0])
                this.visitRuleBody(term.args[1])
                break
            }
            case "event/1": {
                this.visitRuleBody(term.args[0])
                break
            }
            default: {
                this.visitPredRef(term)


            }
        }
    }
    visitPredRef(term: Term) {
        label(term,"pred")
        this.addReference(term)
    }
    visitVarOrFuncOrDataOrPred(term: Term) {
        if (term.syntaxType == "variable") {
            this.visitVariable(term)
        } else if (["!/1", "!./1", "!:/1"].includes(term.nameArity)
            && term.args[0].syntaxType == "variable"
        ) {
            this.visitVariable(term.args[0])
        } else {
            this.visitFuncOrDataOrPred(term)
        }
    }
    visitFuncOrDataOrPred(term: Term) {
        this.addReference(term)
        this.currentClause.called.push(term)
        term.clause = this.currentClause;
    }
    visitVariable(term: Term) {
        term.clause = this.currentClause
        this.currentClause.varMap.add(term.name, term)
    }


    visitFuncRuleHead(term: Term) {
        let [func, funcReturn] = term.args
        this.visitFuncDef(func)
        this.visitFuncReturn(funcReturn)
        this.currentClause.callee = func
    }
    visitFuncDef(func: Term) {
        label(func,"func")
        this.addDefinition(func)
    }
    visitFuncReturn(funcReturn: Term) {
        // throw new Error('Method not implemented.')
    }

    visitFuncDeclFunc(func: Term) {
        label(func,"func")
        this.addDeclaration(func)
    }


    visitDecl(term: Term) {

        switch (term.nameArity) {
            case "pred/1":
                this.visitPredDecl(term.args[0])
                break
            case "func/1":
                this.visitFuncDecl(term.args[0])
                break
            case "use_module/1":
                this.visitUseModuleDecl(term.args[0])
                break
            case "import_module/1":
                this.visitImportModuleDecl(term.args[0])
                break
            case "include_module/1":
                this.visitIncludeModuleDecl(term.args[0])
                break
            case "module/1":
                this.visitModuleDecl(term.args[0])
                break
            case "end_module/1":
                this.visitEndModuleDecl(term.args[0])
                break
            case "type/1":
                this.visitTypeDecl(term.args[0])
                break
            case "interface/0":
                this.visitInterfaceDecl(term)
                break
            case "implemtation/0":
                this.visitImplementationDecl(term)
                break
            case "solver/1":
                let arg = term.args[0]
                if (nameArity(arg, 'type/1')) {
                    // this.visitSolverType(decl)
                }
                break
            case "inst/1":
                this.visitInstDecl(term.args[0])
                break
            case "mode/1":
                this.visitModeDecl(term.args[0])
                break
            case "typesclass/1":
                this.visitTypeclassDecl(term)
                break
            case "pragma/1":
                this.visitPragmaDecl(term)
                break
            case "promise/1":
                this.visitPromiseDecl(term)
                break
            case "initialise/1":
                this.visitInitialiseDecl(term)
                break
            case "finalise/1":
                this.visitFinaliseDecl(term)
                break
            case "mutable/1":
                this.visitMutableDecl(term)
                break
            case "<=/2":
                this.visitDecl(term.args[0])
            default:
                break
        }
    }

    visitTypeDecl(term: Term) {
        // Discriminated unions
        if (nameArity(term, "--->/2")) {
            this.visitTypeNameOrSubtype(term.args[0])
            this.visitTypeConstrutors(term.args[1])
        }
        // Equivalence types

        else if (nameArity(term, "==/2")) {
            this.visitTypeName(term.args[0])
            this.visitTypeConstrutor(term.args[1])
        }
        else{
            // Abstract types
            this.visitTypeName(term)
        }
    }
    visitTypeConstrutors(term: Term) {
        let list = stream(semicolonBinaryTermToList(term))
        list.forEach(x => {
            this.visitTypeConstrutor(x)
        })
    }
    visitTypeConstrutor(term: Term) {
        label(term,"type")
        this.addDefinition(term)
    }
    visitTypeNameOrSubtype(term: Term) {
        if (nameArity(term, "=</2")) {
            let [subtype, supertype] = term.args
            this.visitTypeName(subtype)
        }
        this.visitTypeName(term)
    }
    visitTypeName(term: Term) {
        label(term, "type")
        this.addDefinition(term)
        this.tryAddExport(term)

    }


    visitIncludeModuleDecl(term: Term) {
        let module = this.visitModule(term)
        this.addReference(module)
        this.addImport(module)
    }

    visitImportModuleDecl(term: Term) {
        let module = this.visitModule(term)
        this.addReference(module)
        this.addImport(module)
    }
    visitUseModuleDecl(term: Term) {
        let module = this.visitModule(term)
        this.addReference(module)
        this.addImport(module)
    }
    visitImplementationDecl(decl: Term) {
       this.section == "implementation"
    }
    visitInterfaceDecl(decl: Term) {
        this.section = "interface"
    }
    visitModuleDecl(term: Term) {
        let module = this.visitModule(term)
        if(!this.module){
            this.module= module
        } 
    }
    visitEndModuleDecl(term: Term) {
        let module = this.visitModule(term)
        this.addReference(module)
    }
    visitModule(term: Term) {
        let right = this.visitQualifiedTerm(term)
        label(right, "module")
        return right
    }

    visitQualifiedTerm(term: Term) {
        if (nameArity(term, "./2")) {
            let [left, right] = term.args
            right.qualified = left
            let module = this.visitQualifiedTerm(left)
            label(module, "module")
            this.addReference(left)
            return right
        }
        if (term.arity !== 0) {
            this.addError("module term's arity should be zero", term)
        }
        return term
    }

    visitMutableDecl(decl: Term) {
        // throw new Error('Method not implemented.')
    }
    visitFinaliseDecl(decl: Term) {
        // throw new Error('Method not implemented.')
    }
    visitInitialiseDecl(decl: Term) {
        // throw new Error('Method not implemented.')
    }
    visitPromiseDecl(decl: Term) {
        // throw new Error('Method not implemented.')
    }
    visitPragmaDecl(decl: Term) {
        // throw new Error('Method not implemented.')
    }
    visitTypeclassDecl(decl: Term) {
        // throw new Error('Method not implemented.')
    }
    visitModeDecl(term: Term) {
        if(nameArity(term,"==/2")){
                this.visitMode(term)
        } else if (nameArity(term,"is/2")){
            this.visitFuncOrPredModeDecl(term.args[0])
        }
    }
    visitFuncOrPredModeDecl(term: Term) {
        if(nameArity(term,"=/2")){
            this.visitFuncMode(term.args[0])
        }else{
            this.visitPredMode(term)
        }
    }
    visitPredMode(term: Term) {
        label(term,"pred");
    }
    visitFuncMode(term: Term) {
        label(term,"func");
    }
    visitMode(term: Term) {
        label(term,"mode")
    }
    visitInstDecl(term: Term) {
        if(nameArity(term,"==/2")){
            this.visitInstOrForBlock(term.args[0])
            this.visitInstOrBound(term.args[1])
        }else if(nameArity(term,"-->/2")){
            this.visitInstOrForBlock(term.args[0])
            this.visitInsts(term.args[1])
        }
    }
    visitInsts(term: Term) {
        for (const inst of semicolonBinaryTermToList(term)) {
            this.visitInst(inst)
        }
    }
    visitInstOrBound(term: Term) {
        if(nameArity(term,"bound/2")){
            // TODO
        }else{
            this.visitInst(term)
        }
    }
    visitInstOrForBlock(term: Term) {
        if(nameArity(term,"for/2")){
            this.visitInst(term.args[0])
        }else{
            this.visitInst(term)
        }
    }
    visitInst(term: Term) {
        label(term,"inst")
    }
    visitFuncDecl(term: Term) {
        if (nameArity(term, "=/2")) {
            let [func, ret] = term.args
            this.visitFuncDeclFunc(func)
            this.visitFuncReturn(ret)
        } 
        else {
            this.visitFuncDeclFunc(term)
        }
    }

    visitPredDecl(term: Term) {
        if (nameArity(term, "is/2")) {
            let [pred, determinism] = term.args
            label(pred,"pred")
            this.visitDeterminism(determinism)

            this.addDeclaration(pred)
        } else {
            label(term,"pred")
            this.addDeclaration(term)
        }
    }
    addReference(term: Term) {
        this.reference.add(term.name, term)
        this.addCalled(term)
    }
    addDeclaration(term: Term) {
        this.declaration.add(term.name, term)
        this.tryAddExport(term)
        this.addCallee(term)
    }
    addDefinition(term: Term) {
        this.definition.add(term.name, term)
        this.addCallee(term)
    }
    
    addExport(term: Term) {
        term.qualified = this.module
        this.export.add(term.name ,term)
    }
    addImport(module: Term) {
        this.imports.push(module)
    }
    addError(msg: string, term: Term) {
        this.errors.push(Diagnostic.create(
            term.range,
            msg,
            DiagnosticSeverity.Error,
            undefined,
            'visitor'
            ))
    }
    addCalled(term: Term) {
        term.clause = this.currentClause
        this.currentClause.called.push(term)
    }
    addCallee(term: Term) {
        term.clause = this.currentClause
        this.currentClause.callee = term
    }
    tryAddExport(term:Term){
        if(this.section == "interface"){
            this.addExport(term);
        }
    }
    visitDeterminism(determinism: Term) {
        // throw new Error('Method not implemented.')
    }
    visitSolverDecl(decl: Term) {
        if (decl.arity === 1 && decl.args[0].name === "type") {
            this.visitSolverTypeDecl(decl.args[0])
        }
    }
    visitSolverTypeDecl(arg0: Term) {
        // throw new Error('Method not implemented.')
    }

}


function nameArity(term: Term, nameArity: string) {
    return term.nameArity == nameArity
}
function name(term: Term, name: string) {
    return term.name === name
}
function arity(term: Term, arity: number) {
    return term.arity === arity
}
function* semicolonBinaryTermToList(term: Term) {
    for (; ;) {
        if (nameArity(term, ";/2")) {
            yield term.args[0]
            term = term.args[1]
        } else {
            yield term
            break;
        }
    }
    return undefined
}

export function label(term: Term, semanticType: SemanticType) {
    term.semanticType = semanticType
}

function isVariable(term: Term) {
    return term.syntaxType === "variable"
}
function isSpecialDataTerm(term: Term):boolean {
    return (isConditionalExpr(term)
        || isRecordSyntexExpr(term)
        || isUnificationExpr(term)
        || isLambdaExpr(term)
        || isHigerOrderFuncApplication(term)
        || isExplicitTypeQualification(term))??false
}

function isConditionalExpr(term: Term) {
    if (["else/2",";/2"].includes(term.nameArity)){
        label(term,"conditional")
        return true;
    }
}

function isRecordSyntexExpr(term: Term) {
    if( ["^/2",":=/2"].includes(term.nameArity)){
        label(term,"record")
        return true
    }
}

function isUnificationExpr(term: Term) {
    if(term.nameArity === "@/2"){
        label(term,"unification")
        return true
    }
}
function isHigerOrderFuncApplication(term: Term) {
    if (term.name === "apply" && term.arity>0){
        label(term,"apply")
        return true
    }
}

function isExplicitTypeQualification(term: Term){
    if([":/2","with_type/2"].includes(term.nameArity)){
        label(term, "explicitType")
        return true
    }
}

function isLambdaExpr(term: Term) {
    if( [":-/2","-->/2"].includes(term.nameArity)){
        label (term,"lambda")
        return true
    }
}

function fieldTransform(term: Term) {
    term.name == term.name + " :=";
    term.arity +=1
    updateNameArity(term) 
}

function updateNameArity(term: Term) {
    term.nameArity = term.name + "/"+term.arity
}

export type SemanticType = 
    "func"|
    "pred"|
    "type"|
    "inst"|
    "mode"|
    "module"|
    "variable"|
    "float"|
    "integer"|
    "string"|
    SpecialDataTerm
export type SpecialDataTerm = 
    'conditional'|
    "record"|
    "apply"|
    "lambda"|
    "unification"|
    "explicitType"
    