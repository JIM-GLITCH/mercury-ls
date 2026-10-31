import { describe, it, expect } from 'vitest'
import { Parser } from '../mercury-parser'
import { Visitor } from '../document-visitor'

describe('import module declarations', () => {
  it('accepts comma-separated modules', async () => {
    const doc = {
      parseResult: Parser.parse(':- module foo.\n:- import_module io, list.\n'),
    } as any

    const visitor = new Visitor()
    await visitor.visit(doc, {} as any)

    const moduleArityErrors = visitor.errors.filter((error: any) =>
      error.message.includes("module term's arity should be zero"),
    )

    expect(moduleArityErrors).toEqual([])
    expect(doc.visitResult?.imports.length).toBe(2)
  })
})
