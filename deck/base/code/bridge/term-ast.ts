// The slice of the milled term-lang AST (from @term/make) that the bridge reads.
//
// Base defines this contract locally rather than depending on the compiler, so it stays
// self-contained. A real `@term/make` `Program` is structurally assignable to `TermProgram`: each
// type here is a supertype of its compiler counterpart (extra fields on the real nodes, like `span`
// and `type`, are permitted on assignment), so the mesh backend passes the milled program with no
// cast. The bridge reads only what is declared here.
//
// See note/library/base/design/asset-repositories-and-font-projection.md.

// A field type. `kind` is the term type kind (`string`, `integer`, `named`, `function`, ...);
// `element`/`value`/`name` are read only for the kinds that carry them.
export type TermType = {
  kind: string
  element?: TermType
  key?: TermType
  value?: TermType
  name?: string
}

// A value expression. Only the literal forms (`string`, `integer`, `float`, `boolean`) and the
// `record` form (a nested or top-level `make`) are read; every other form is opaque here.
export type TermExpression = {
  form: string
  value?: string | number | bigint | boolean
  // present when form is 'record'
  name?: string
  fields?: ReadonlyArray<{ name: string; value: TermExpression }>
  functionFree?: boolean
}

// A form field (`link <name>, like <type>`), with `identity` set by `note id`.
export type TermField = {
  name: string
  type: TermType
  identity?: boolean
}

// A top-level statement. `record-type` (a `form`), `expression` wrapping a `record` (a `make`), and
// `let` (a `host` constant) are handled; any other statement is ignored.
export type TermStatement = {
  form: string
  name?: string
  // record-type
  fields?: ReadonlyArray<TermField>
  functionFree?: boolean
  // expression
  expr?: TermExpression
  // let (host)
  init?: TermExpression
  mutable?: boolean
}

export type TermProgram = ReadonlyArray<TermStatement>
