import type { SemanticTokens } from 'vscode-languageserver'
import { Term, termRange } from './term'
import type { MercuryDocument } from './document-manager'
import { tokenRange } from './utils'

export const semanticTokenLegend = {
  tokenTypes: [
    'namespace',
    'type',
    'class',
    'enum',
    'interface',
    'struct',
    'typeParameter',
    'parameter',
    'variable',
    'property',
    'enumMember',
    'event',
    'function',
    'method',
    'modifier',
    'comment',
    'string',
    'keyword',
    'number',
    'regexp',
    'operator',
  ],
  tokenModifiers: [],
}

const tokenTypeIndexBySemanticType: Record<string, number> = {
  module: 0,
  type: 1,
  constructor: 10,
  fieldname: 9,  // property
  inst: 17,
  mode: 17,
  variable: 8,
  func: 12,
  pred: 12,
  float: 18,
  integer: 18,
  string: 15,
  implementationDefined: 17,
  operator: 20,
}

function classifyTerm(term: Term): number | undefined {
  const semanticType = term.semanticType
  if (semanticType && tokenTypeIndexBySemanticType[semanticType] !== undefined) {
    return tokenTypeIndexBySemanticType[semanticType]
  }
  switch (term.syntaxType) {
    case 'variable':
      return tokenTypeIndexBySemanticType.variable
    case 'string':
      return tokenTypeIndexBySemanticType.string
    case 'integer':
    case 'float':
      return tokenTypeIndexBySemanticType.integer
    default:
      return undefined
  }
}

function emitTokenRange(
  data: number[],
  state: { line: number; char: number },
  seen: Set<string>,
  start: { line: number; character: number },
  length: number,
  tokenType: number,
): void {
  const key = `${start.line}:${start.character}:${length}:${tokenType}`
  if (seen.has(key)) return
  seen.add(key)

  const deltaLine = start.line - state.line
  const deltaStart = deltaLine === 0 ? start.character - state.char : start.character
  data.push(deltaLine, deltaStart, length, tokenType, 0)
  state.line = start.line
  state.char = start.character
}

function emitTokenForTerm(
  term: Term,
  data: number[],
  state: { line: number; char: number },
  seen: Set<string>,
): void {
  const tokenType = classifyTerm(term)
  if (tokenType === undefined) return

  const range = tokenRange(term.token)
  const text = term.name || ''
  if (!text || !range || range.start.line < 0) return

  emitTokenRange(data, state, seen, range.start, text.length, tokenType)
}

export function semanticTokensForDocument(document: MercuryDocument): SemanticTokens {
  const data: number[] = []
  const state = { line: 0, char: 0 }
  const seen = new Set<string>()

  function walk(term: Term | undefined): void {
    if (!term) return

    emitTokenForTerm(term, data, state, seen)
    for (const arg of term.args ?? []) {
      walk(arg)
    }
  }

  const root = document.parseResult?.value
  if (root) {
    for (const clause of root.args ?? []) {
      walk(clause)
      walk(clause.term)
    }
  }

  return { data }
}
