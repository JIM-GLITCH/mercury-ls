import { describe, it, expect } from 'vitest'
import { Parser } from '../mercury-parser'

import { createMercuryServices } from '../services'

describe('import module declarations', () => {
  it('accepts comma-separated modules', async () => {
    const services = createMercuryServices()
    const doc = {
      parseResult: Parser.parse(':- module foo.\n:- import_module io, list.\n'),
    } as any

    const index = services.index
    await index.index(doc, {} as any)

    const moduleArityErrors = index.errors.filter((error: any) =>
      error.message.includes("module term's arity should be zero"),
    )

    expect(moduleArityErrors).toEqual([])
    expect(services.index.get(doc)?.imports.length).toBe(2)
  })
})
