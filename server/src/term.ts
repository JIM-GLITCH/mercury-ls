type term = functor|variable

class functor{
	functor:constant
	children: term[]
}
class variable{
	functor:Var
}
class Var {

}
type constant =  atom