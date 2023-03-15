import { RootNode, Term } from './term'

export interface TermLocator{
    getTermPath(term:Term):number[];
    getTerm(term:RootNode,path:number[]):Term|undefined
}
export class DefaultTermLocater implements TermLocator{
    getTermPath(term: Term): number[] {
        let termPath = []
        for(;;){
            if(!term.containerIndex){
                break
            }
            termPath.push(term.containerIndex);
            term = term.container!;
        }
        termPath.reverse()
        return termPath
    }
    getTerm(rootNode: RootNode, path: number[]): Term | undefined {
        let term:Term=rootNode;
        for (const index of path) {
            term= term?.args[index]
        }
        return term;
    }
    
}