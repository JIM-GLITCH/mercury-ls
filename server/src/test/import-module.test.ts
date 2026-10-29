import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Parser } from '../mercury-parser';
import { Visitor } from '../document-visitor';

describe('import module declarations', () => {
  it('accepts comma-separated modules', async () => {
    const doc = {
      parseResult: Parser.parse(':- module foo.\n:- import_module io, list.\n')
    } as any;

    const visitor = new Visitor();
    await visitor.visit(doc, {} as any);

    const moduleArityErrors = visitor.errors.filter((error: any) =>
      error.message.includes("module term's arity should be zero")
    );

    assert.deepStrictEqual(moduleArityErrors, []);
    assert.strictEqual(doc.visitResult?.imports.length, 2);
  });
});
