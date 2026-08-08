// Lift compiled term-lang (@term/make) declarations into base schemas and records.
//
// A repository's .tree files are term-lang source. `@term/make` parses and mills them into a typed
// Program. This module translates the DATA-ONLY (function-free) part of that Program into base: a
// `form` becomes a Form, a `make` becomes a RecordNode, and a `host` path binding becomes an asset
// record referencing bytes by hash. Behaviour (functions, tasks) is not data and is not lifted.
//
// The translation is pure. It does no file IO, runs no compiler, and touches no repository. The two
// things it cannot do purely are injected: reading and hashing a host file's bytes (`resolveBlob`),
// and reconciling a natural key to a durable mark by find-or-create, always a uuidv4 (`resolveMark`).
//
// The make AST is imported for its TYPES only, so this adds no runtime dependency on the compiler.
// The compiler runs in the editing session and hands the milled Program here.
//
// See note/library/base/design/asset-repositories-and-font-projection.md.

import type { Expression, Program, Type } from '@term/make/code/compile/node'
import type { Constraint, Form, Like, Property } from '@term/base/code/form/form'
import { form, hold, property } from '@term/base/code/form/form'
import type { CollectionKind, Mark, RecordNode, Value } from '@term/base/code/base/type'
import {
  blob,
  boolean,
  date,
  decimal,
  integer,
  ref,
  text,
} from '@term/base/code/base/make'

// path (a host literal) -> the content hash of the file's bytes, or undefined if it cannot be read.
export type BlobResolver = (path: string) => string | undefined

// (form name, natural key) -> the record's durable mark. Find-or-create: an existing record with the
// same key keeps its mark, a new key mints a fresh uuidv4. Never a hash of content.
export type MarkResolver = (form: string, naturalKey: string) => Mark

export type LiftOptions = {
  resolveMark?: MarkResolver
  resolveBlob?: BlobResolver
  // the source file these declarations came from, stamped onto each record as `~source` provenance
  sourceFile?: string
}

export type Skip = {
  kind: 'form' | 'record' | 'host'
  name: string
  reason: string
}

export type LiftResult = {
  forms: Array<Form>
  records: Array<RecordNode>
  skipped: Array<Skip>
}

// The reserved field a record carries to point back at the source it compiled from.
const SOURCE = '~source'

// A named term type that maps to a base scalar. Anything else named is a reference to another form.
const NAMED_BASE: Record<string, Like> = {
  text: { base: 'text' },
  string: { base: 'text' },
  integer: { base: 'integer' },
  natural: { base: 'integer' },
  'natural-number': { base: 'integer' },
  number: { base: 'integer' },
  decimal: { base: 'decimal' },
  float: { base: 'decimal' },
  boolean: { base: 'boolean' },
  date: { base: 'date' },
  timestamp: { base: 'date' },
  uuid: { base: 'uuid' },
  mark: { base: 'uuid' },
}

// A term field type as a base `Like`, plus the collection kind when the field is a list or map.
function likeOf(type: Type): { like: Like; collection?: CollectionKind } {
  switch (type.kind) {
    case 'string':
      return { like: { base: 'text' } }
    case 'number':
      return { like: { base: 'integer' } }
    case 'float':
      return { like: { base: 'decimal' } }
    case 'boolean':
      return { like: { base: 'boolean' } }
    case 'array':
      return { like: likeOf(type.element).like, collection: 'list' }
    case 'map':
      return { like: likeOf(type.value).like, collection: 'map' }
    case 'named':
      return { like: NAMED_BASE[type.name] ?? { ref: type.name } }
    default:
      // unknown / dynamic / unit / bytes / variable: default to text, the safe carrier
      return { like: { base: 'text' } }
  }
}

// A record-type node as a base Form. Returns undefined for a form that carries behaviour.
export function liftForm(node: {
  name: string
  fields: Array<{ name: string; type: Type; identity?: boolean }>
  functionFree?: boolean
}): Form | undefined {
  if (node.functionFree === false) {
    return undefined
  }

  const properties: Array<Property> = node.fields.map(field => {
    const { like, collection } = likeOf(field.type)
    const constraints: Array<Constraint> = []

    // `note id`: the field whose value is the record's natural key, mapped to a `mark` constraint.
    if (field.identity) {
      constraints.push(hold('mark'))
    }

    return property(
      field.name,
      like,
      collection ? { constraints, collection } : { constraints },
    )
  })

  return form(node.name, properties)
}

// The raw scalar string of a literal expression, or undefined when it is not a plain scalar (a nested
// record, a call, a closure). A non-scalar is not pure data and is not lifted into a field.
function scalarString(expr: Expression): string | undefined {
  switch (expr.form) {
    case 'string':
      return expr.value
    case 'integer':
      return expr.value.toString()
    case 'float':
      return String(expr.value)
    case 'boolean':
      return expr.value ? 'true' : 'false'
    default:
      return undefined
  }
}

class CoerceError extends Error {}

// A bound literal as a base Value, coerced to the field's declared type. Angle-bracket literals mill
// as strings, so the form declaration is the authority for the value's kind. With no declared type,
// the literal's own form decides.
function valueOf(expr: Expression, like: Like | undefined, field: string): Value {
  const raw = scalarString(expr)

  if (raw === undefined) {
    throw new CoerceError(`field ${field}: value is not a scalar literal`)
  }

  if (like && 'ref' in like) {
    // a reference field's value is the target's key; the target mark is resolved on reconcile
    return ref(raw)
  }

  const base = like && 'base' in like ? like.base : undefined

  switch (base) {
    case 'integer':
      try {
        return integer(BigInt(raw))
      } catch {
        throw new CoerceError(`field ${field}: ${raw} is not an integer`)
      }
    case 'decimal':
      return decimal(raw)
    case 'boolean':
      return boolean(raw === 'true')
    case 'date':
      return date(raw)
    case 'uuid':
    case 'text':
      return text(raw)
    default:
      // no declared type: carry the literal in its own kind
      switch (expr.form) {
        case 'integer':
          return integer(expr.value)
        case 'float':
          return decimal(String(expr.value))
        case 'boolean':
          return boolean(expr.value)
        default:
          return text(raw)
      }
  }
}

// A record (make) node as a base RecordNode. `forms` supplies the declared field types for coercion
// and marks the natural-key field. Throws CoerceError on a value that does not fit its declared type.
export function liftRecord(
  node: {
    name: string
    fields: Array<{ name: string; value: Expression }>
    functionFree?: boolean
  },
  forms: Map<string, Form>,
  opts?: LiftOptions,
): RecordNode {
  const schema = forms.get(node.name)
  const fields = new Map<string, Value>()
  let naturalKey: string | undefined

  for (const bind of node.fields) {
    const prop = schema?.properties.find(p => p.name === bind.name)
    fields.set(bind.name, valueOf(bind.value, prop?.like, bind.name))

    if (prop?.constraints.some(c => c.kind === 'mark')) {
      naturalKey = scalarString(bind.value)
    }
  }

  if (opts?.sourceFile !== undefined) {
    fields.set(SOURCE, text(opts.sourceFile))
  }

  const record: RecordNode = { type: node.name, fields }

  if (naturalKey !== undefined && opts?.resolveMark) {
    record.mark = opts.resolveMark(node.name, naturalKey)
  }

  return record
}

// A whole milled Program lifted into base forms and records. Forms are lifted first, so records can
// be coerced against their declared field types. A node that carries behaviour, or a value that does
// not fit, is skipped with a reason rather than silently dropped or half-applied.
export function liftProgram(
  program: Program,
  opts?: LiftOptions,
): LiftResult {
  const forms: Array<Form> = []
  const formMap = new Map<string, Form>()
  const records: Array<RecordNode> = []
  const skipped: Array<Skip> = []

  // pass 1: forms, needed to coerce the records that follow
  for (const stmt of program) {
    if (stmt.form !== 'record-type') {
      continue
    }

    if (stmt.functionFree === false) {
      skipped.push({
        kind: 'form',
        name: stmt.name,
        reason: 'has a function-typed field, so it is code, not data',
      })
      continue
    }

    const lifted = liftForm(stmt)

    if (lifted) {
      forms.push(lifted)
      formMap.set(lifted.name, lifted)
    }
  }

  // pass 2: records (a top-level `make` is an expression statement) and host asset bindings
  for (const stmt of program) {
    if (stmt.form === 'expression' && stmt.expr.form === 'record') {
      const expr = stmt.expr

      if (expr.functionFree === false) {
        skipped.push({
          kind: 'record',
          name: expr.name,
          reason: 'has a function value, so it is not pure data',
        })
        continue
      }

      try {
        records.push(liftRecord(expr, formMap, opts))
      } catch (error) {
        skipped.push({
          kind: 'record',
          name: expr.name,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    } else if (stmt.form === 'let' && !stmt.mutable) {
      liftHost(stmt, opts, records, skipped)
    }
  }

  return { forms, records, skipped }
}

// A `host <name>, <path>` binding as an asset record referencing the file's bytes by hash. A
// value-less or non-path host is not an asset and is ignored.
function liftHost(
  stmt: { name: string; init: Expression; mutable: boolean },
  opts: LiftOptions | undefined,
  records: Array<RecordNode>,
  skipped: Array<Skip>,
): void {
  if (stmt.init.form !== 'string') {
    return
  }

  const path = stmt.init.value
  const hash = opts?.resolveBlob?.(path)

  if (hash === undefined) {
    skipped.push({
      kind: 'host',
      name: stmt.name,
      reason: `could not resolve bytes for ${path}`,
    })
    return
  }

  const fields = new Map<string, Value>([
    ['name', text(stmt.name)],
    ['path', text(path)],
    ['blob', blob(hash)],
  ])

  if (opts?.sourceFile !== undefined) {
    fields.set(SOURCE, text(opts.sourceFile))
  }

  const record: RecordNode = { type: 'asset', fields }

  if (opts?.resolveMark) {
    record.mark = opts.resolveMark('asset', stmt.name)
  }

  records.push(record)
}
