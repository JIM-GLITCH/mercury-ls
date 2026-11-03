const { Parser } = require('./out/mercury-parser')

function dump(t, d = 0) {
  if (!t) return 'null'
  const ty = t.syntaxType
  const name = t.name || ''
  if (ty === 'atom' || ty === 'functor') {
    const args = t.args || []
    if (args.length)
      return name + '/' + args.length + '(' + args.map(a => dump(a, d + 1)).join(', ') + ')'
    return name
  }
  if (ty === 'integer' || ty === 'float') return t.token.text
  if (ty === 'variable') return t.name
  if (ty === '$clause') return '$clause(' + dump(t.args && t.args[0], d + 1) + ')'
  return ty
}

const src = `:- module test.
:- interface.
:- pred p(int::in, int::in) is det.
:- implementation.
p(K, Key) :- ( if K = Key then true else true ).
:- end_module test.
`
const r = Parser.parse(src)
console.log('num clauses:', r.value.args.length)
for (let i = 0; i < r.value.args.length; i++) {
  console.log('clause[' + i + ']:', dump(r.value.args[i]))
}
