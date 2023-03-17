import { Hover, HoverParams, MarkupContent } from 'vscode-languageserver'
import { nameArity } from './utils'
import { search, termRange } from './term'
import { mercuryDocuments } from './document-manager'
import { URI } from 'vscode-uri'

export async function HoverProvider(params:HoverParams) {
    let pos = params.position;
    let uri = params.textDocument.uri;
    let doc = mercuryDocuments.getOrCreateDocument(URI.parse(uri));
    let  term  = search(doc.parseResult.value,pos)
    if(!term)
        return 
    let msg;
    if(term.semanticType){
        switch (term.semanticType){
            case 'func':
            case 'pred':
            case 'type':
            case "inst":
                msg = nameArity(term)
                break ;
            case 'module':
            case "variable":
                msg = term.name
                break ;
        }
        return {
            contents:{
                kind:"markdown",
                value:[
                    '```mercury',
                    `(${term.semanticType}) ${msg}`,
                    '```'
                ].join('\n')
            } as MarkupContent,
            range:termRange(term)
        } as Hover
    }
    else{
        switch (term.syntaxType) {
            case 'string':
            case 'variable':
            case 'integer':
            case 'float':
            case 'implementation_defined':
                msg = term.name;
                break ;
            case 'atom':
                msg = nameArity(term);
                break ;
            default :
                msg = term.name;
                break;
        }
    }
    
let message =`\`\`\`mercury
${msg}
\`\`\`
`
    return {
        contents:{
            kind:"markdown",
            value:message
        } as MarkupContent,
        range:termRange(term)
    } as Hover
}