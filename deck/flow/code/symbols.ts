// The symbol index: the static model an editor navigates. Built from a checked program, it records every definition
// (function, type, variant, trait, parameter, local) with its span and signature, every name reference with its
// span, and the scope visible at any position. Go-to-definition, find-references, rename, document symbols,
// completion, and signature help are all thin queries over this index. Spans are 0-based, matching the compiler and
// the LSP wire.
//
// TWO SPANS PER ENTRY. `span` is what the compiler recorded: for a reference, the whole expression it stands in (the
// mill gives a call's callee the span of the entire call, arguments and all), and for a definition, the whole
// statement. `name` is where the NAME itself is written, found in the document text. Rename edits `name` and never
// `span`: editing `span` replaced a whole `task` with its new name, body included.

import type {
  Expression,
  Program,
  Statement,
} from '@term/make/code/compile/node'
import { showType } from '@term/make/code/compile/node'
import type { Span } from '@term/make/code/parser/diagnostic'
import { importFindsOf, makeParseMemo } from '@term/make/code/compile/load'
import type { LspPosition } from '@term/flow/code/analyze'
import { within } from '@term/flow/code/analyze'

export type SymbolKind =
  | 'function'
  | 'type'
  | 'variant'
  | 'trait'
  | 'parameter'
  | 'local'
export type Definition = {
  name: string
  kind: SymbolKind
  span: Span
  detail: string
  // where the name is written, when the text was given and the name was found in it
  at?: Span
}
export type Reference = { name: string; span: Span; at?: Span }
// the names a function makes available, with the span where each is introduced (for scope-aware completion)
export type FunctionScope = {
  name: string
  span: Span
  locals: {
    name: string
    kind: SymbolKind
    detail: string
    span: Span
    at?: Span
  }[]
}

export type SymbolIndex = {
  definitions: Map<string, Definition>
  references: Reference[]
  functions: Definition[]
  scopes: FunctionScope[]
  // a function name -> its parameter types and result, for signature help
  signatures: Map<
    string,
    { params: { name: string; type: string }[]; result: string }
  >
}

// The name a reader wrote, from the one the checker uses. Module scope splits a name two files define into
// `name__in<g>_<k>`, and arity overloading into `name__<arity>` or `name__any<g>_<arity>` (check/overload.ts,
// check/scope.ts). Those are internal, and an outline, a hover or a completion item shows the written one.
export function writtenName(name: string): string {
  return name.replace(/(?:__(?:in\d+_\d+|any\d+_\d+|\d+))+$/, '')
}

function signatureText(
  node: Extract<Statement, { form: 'function' }>,
): string {
  const params = node.params
    .map(p => `${p.name}: ${showType(p.type ?? { kind: 'unknown' })}`)
    .join(', ')

  return `(${params}) -> ${showType(node.result ?? { kind: 'unit' })}`
}

// a character that may be part of a Term name (kebab case, with digits)
const NAME_CHAR = /[A-Za-z0-9-]/

// the span of `name` written as a whole word inside `span`, searching from its start. Undefined when the text does
// not hold it (a synthesized node, or a span from a different text).
export function findName(
  lines: string[],
  span: Span,
  name: string,
  // a pattern the name must follow on its line, tried first (`take ` for a parameter)
  after?: RegExp,
): Span | undefined {
  const written = writtenName(name)

  if (!written) {
    return undefined
  }

  const last = Math.min(span.end.line, lines.length - 1)

  for (const strict of after ? [true, false] : [false]) {
    for (let line = Math.max(0, span.start.line); line <= last; line++) {
      const text = lines[line] ?? ''
      const from = line === span.start.line ? span.start.column : 0
      const to = line === span.end.line ? Math.min(text.length, span.end.column) : text.length

      let at = text.indexOf(written, from)

      while (at >= 0 && at + written.length <= to) {
        const before = at > 0 ? text[at - 1]! : ' '
        const following = text[at + written.length] ?? ' '

        if (
          !NAME_CHAR.test(before) &&
          !NAME_CHAR.test(following) &&
          (!strict || after!.test(text.slice(0, at)))
        ) {
          return {
            start: { line, column: at },
            end: { line, column: at + written.length },
          }
        }

        at = text.indexOf(written, at + 1)
      }
    }
  }

  return undefined
}

export function buildIndex(program: Program, text?: string): SymbolIndex {
  const definitions = new Map<string, Definition>()
  const references: Reference[] = []
  const functions: Definition[] = []
  const scopes: FunctionScope[] = []
  const signatures = new Map<
    string,
    { params: { name: string; type: string }[]; result: string }
  >()

  const lines = text?.split('\n')
  const nameIn = (span: Span, name: string, after?: RegExp): Span | undefined =>
    lines ? findName(lines, span, name, after) : undefined

  // `find shout, name yell`: the mill binds every `yell` to `shout`, so a reference named `shout` is WRITTEN `yell`
  const aliases = new Map<string, string>()

  if (text) {
    for (const entry of importFindsOf({ file: '<index>', text }, makeParseMemo(4))) {
      entry.names.forEach((name, i) => {
        const alias = entry.aliases[i]

        if (alias) {
          aliases.set(name, alias)
        }
      })
    }
  }

  const define = (
    name: string,
    kind: SymbolKind,
    span: Span,
    detail: string,
    after?: RegExp,
  ): Definition => {
    const def: Definition = { name, kind, span, detail, at: nameIn(span, name, after) }

    if (!definitions.has(name)) {
      definitions.set(name, def)
    }

    return def
  }

  // top-level definitions first, so forward references resolve
  for (const statement of program) {
    switch (statement.form) {
      case 'function': {
        const def = define(
          statement.name,
          'function',
          statement.span,
          signatureText(statement),
          /(?:^|\s)(?:task|rule)\s+$/,
        )

        functions.push(def)
        signatures.set(statement.name, {
          params: statement.params.map(p => ({
            name: p.name,
            type: showType(p.type ?? { kind: 'unknown' }),
          })),
          result: showType(statement.result ?? { kind: 'unit' }),
        })
        break
      }

      case 'record-type': {
        define(
          statement.name,
          'type',
          statement.span,
          statement.variants.length ? 'enum' : 'struct',
          /(?:^|\s)form\s+$/,
        )

        for (const v of statement.variants) {
          define(
            v.name,
            'variant',
            statement.span,
            `${statement.name} variant`,
            /(?:^|\s)case\s+$/,
          )
        }

        break
      }

      case 'mask':
        define(statement.name, 'trait', statement.span, 'trait', /(?:^|\s)mask\s+$/)
        break
      default:
        break
    }
  }

  const refer = (name: string, span: Span): void => {
    const alias = aliases.get(name)

    references.push({ name, span, at: nameIn(span, name) ?? (alias ? nameIn(span, alias) : undefined) })
  }

  // references + per-function local scopes
  const expr = (node: Expression, locals?: FunctionScope['locals']): void => {
    switch (node.form) {
      case 'variable':
      case 'hole':
        refer(node.name, node.span)
        break
      case 'record':
        refer(node.name, node.span)
        node.fields.forEach(f => expr(f.value, locals))
        node.positional?.forEach(p => expr(p, locals))
        break
      case 'binary':
        expr(node.left, locals)
        expr(node.right, locals)
        break
      case 'unary':
        expr(node.operand, locals)
        break
      case 'call':
        expr(node.callee, locals)
        node.args.forEach(a => expr(a, locals))
        break
      case 'member':
        expr(node.target, locals)

        if (node.index) {
          expr(node.index, locals)
        }

        break
      case 'await':
        expr(node.expr, locals)
        break
      case 'array':
        node.items.forEach(i => expr(i, locals))
        break
      case 'map':
        node.entries.forEach(e => {
          expr(e.key, locals)
          expr(e.value, locals)
        })
        break
      case 'template':
        for (const part of node.parts) {
          if (typeof part !== 'string') {
            expr(part, locals)
          }
        }

        break
      case 'closure':
        // a task written as a value: its parameters are locals of the enclosing function's scope from here on
        if (locals) {
          for (const p of node.params) {
            locals.push({
              name: p.name,
              kind: 'parameter',
              detail: showType(p.type ?? { kind: 'unknown' }),
              span: node.span,
              at: nameIn(node.span, p.name, /(?:^|\s)take\s+$/),
            })
          }

          walkStatements(node.body, locals)
        }

        break
      case 'conditional':
        node.branches.forEach(b => {
          expr(b.cond, locals)
          expr(b.value, locals)
        })

        if (node.otherwise) {
          expr(node.otherwise, locals)
        }

        break
      default:
        break
    }
  }

  const walkStatements = (
    body: Statement[],
    locals: FunctionScope['locals'],
  ): void => {
    for (const s of body) {
      switch (s.form) {
        case 'let':
          expr(s.init, locals)
          locals.push({
            name: s.name,
            kind: 'local',
            detail: showType(s.type ?? { kind: 'unknown' }),
            span: s.span,
            at: nameIn(s.span, s.name, /(?:^|\s)(?:save|host)\s+$/),
          })
          break
        case 'assign':
          expr(s.target, locals)
          expr(s.value, locals)
          break
        case 'expression':
        case 'hold':
          expr(s.expr, locals)
          break
        case 'return':
          if (s.value) {
            expr(s.value, locals)
          }

          break
        case 'throw':
          expr(s.value, locals)
          break
        case 'while':
          expr(s.cond, locals)
          walkStatements(s.body, locals)
          break
        case 'for-each':
          expr(s.iterable, locals)

          for (const name of [s.item, s.index]) {
            if (name) {
              locals.push({
                name,
                kind: 'local',
                detail: 'iteration item',
                span: s.span,
                at: nameIn(s.span, name, /(?:^|\s)(?:name|take)\s+$/),
              })
            }
          }

          walkStatements(s.body, locals)
          break
        case 'if':
          s.branches.forEach(b => {
            expr(b.cond, locals)
            walkStatements(b.body, locals)
          })

          if (s.otherwise) {
            walkStatements(s.otherwise, locals)
          }

          break
        case 'match':
          expr(s.subject, locals)
          s.cases.forEach(c => walkStatements(c.body, locals))

          if (s.otherwise) {
            walkStatements(s.otherwise, locals)
          }

          break
        case 'guard':
          // `note unsafe` and its handler: the body is ordinary code, and the handler's `take <name>` a local
          walkStatements(s.body, locals)

          if (s.catch) {
            locals.push({
              name: s.catch.name,
              kind: 'local',
              detail: 'exception',
              span: s.catch.span,
              at: nameIn(s.catch.span, s.catch.name, /(?:^|\s)take\s+$/),
            })
            walkStatements(s.catch.body, locals)
          }

          break
        case 'function':
          walkStatements(s.body, locals)
          break
        default:
          break
      }
    }
  }

  for (const statement of program) {
    if (statement.form !== 'function') {
      continue
    }

    const locals: FunctionScope['locals'] = statement.params.map(p => ({
      name: p.name,
      kind: 'parameter' as const,
      detail: showType(p.type ?? { kind: 'unknown' }),
      span: statement.span,
      at: nameIn(statement.span, p.name, /(?:^|\s)(?:take|slot)\s+$/),
    }))

    walkStatements(statement.body, locals)

    for (const list of [statement.have, statement.must]) {
      list?.forEach(e => expr(e, locals))
    }

    scopes.push({ name: statement.name, span: statement.span, locals })
  }

  return { definitions, references, functions, scopes, signatures }
}

// every function's signature (name -> params + result). A signature is span-free, so this is safe to take over the
// whole merged program: signature help and argument-type ranking then work for imported functions too, while the
// document-scoped index keeps definitions / references local.
export function signaturesOf(
  program: Program,
): SymbolIndex['signatures'] {
  const signatures: SymbolIndex['signatures'] = new Map()

  for (const statement of program) {
    if (statement.form === 'function') {
      signatures.set(statement.name, {
        params: statement.params.map(p => ({
          name: p.name,
          type: showType(p.type ?? { kind: 'unknown' }),
        })),
        result: showType(statement.result ?? { kind: 'unit' }),
      })
    }
  }

  return signatures
}

// the reference under the position. A reference whose NAME is under the cursor wins; failing that, the narrowest
// reference whose expression contains it (the cursor on `read` of `read n` still means `n`).
export function referenceAt(
  index: SymbolIndex,
  position: LspPosition,
  strict = false,
): Reference | undefined {
  const named = index.references.find(r => r.at && within(r.at, position))

  if (named || strict) {
    return named
  }

  let best: Reference | undefined

  for (const ref of index.references) {
    if (!within(ref.span, position)) {
      continue
    }

    if (!best || size(ref.span) < size(best.span)) {
      best = ref
    }
  }

  return best
}

// what a position names: a reference, a top-level definition's name, or a parameter's or local's name, with whether
// it is a local of one function (whose occurrences are confined to that function)
export type Named = {
  name: string
  // the function whose scope holds the name, for a parameter or a local
  scope?: FunctionScope
}

export function symbolAt(
  index: SymbolIndex,
  position: LspPosition,
  strict = false,
): Named | undefined {
  // a definition's own name
  for (const def of index.definitions.values()) {
    if (def.at && within(def.at, position)) {
      return { name: def.name }
    }
  }

  for (const scope of index.scopes) {
    for (const local of scope.locals) {
      if (local.at && within(local.at, position)) {
        return { name: local.name, scope }
      }
    }
  }

  const ref = referenceAt(index, position, strict)

  if (!ref) {
    return undefined
  }

  // a reference to a parameter or local of the function it sits in is that local, not a top-level name
  const scope = index.scopes.find(
    s => within(s.span, lsp(ref.span.start)) && s.locals.some(l => l.name === ref.name),
  )

  return scope ? { name: ref.name, scope } : { name: ref.name }
}

// every place a symbol's NAME is written: its references and its definition, confined to the declaring function for a
// parameter or local. Only name spans: a reference whose name was not found in the text is left out rather than
// answered with its whole expression.
export function occurrencesOf(
  index: SymbolIndex,
  name: string | Named,
): Span[] {
  const symbol = typeof name === 'string' ? { name } : name
  const scope = symbol.scope
  const out: Span[] = []
  const seen = new Set<string>()

  const add = (span: Span | undefined): void => {
    if (!span) {
      return
    }

    const key = `${span.start.line}:${span.start.column}`

    if (!seen.has(key)) {
      seen.add(key)
      out.push(span)
    }
  }

  for (const ref of index.references) {
    if (ref.name !== symbol.name) {
      continue
    }

    const inScope = scope ? within(scope.span, lsp(ref.span.start)) : true
    // a reference inside a function that has its own local of this name is that local's, not the top-level one
    const shadowed =
      !scope &&
      index.scopes.some(
        s => within(s.span, lsp(ref.span.start)) && s.locals.some(l => l.name === symbol.name),
      )

    if (inScope && !shadowed) {
      add(ref.at)
    }
  }

  if (scope) {
    for (const local of scope.locals) {
      if (local.name === symbol.name) {
        add(local.at)
      }
    }
  } else {
    add(index.definitions.get(symbol.name)?.at)
  }

  return out.sort(
    (a, b) => a.start.line - b.start.line || a.start.column - b.start.column,
  )
}

// the names visible at a position: every top-level definition plus the enclosing function's parameters and the
// locals introduced before the cursor
export function scopeAt(
  index: SymbolIndex,
  position: LspPosition,
): Definition[] {
  const out: Definition[] = [...index.definitions.values()]
  const fn = index.scopes.find(s => within(s.span, position))

  if (fn) {
    for (const local of fn.locals) {
      if (local.kind === 'parameter' || before(local.span, position)) {
        out.push({
          name: local.name,
          kind: local.kind,
          span: local.span,
          detail: local.detail,
          at: local.at,
        })
      }
    }
  }

  return out
}

// every call in a program, with its callee name and its arguments. Walks every statement and expression form a
// body can hold, so a call inside `note unsafe`, a closure or a text template is found as well.
export function forEachCall(
  program: Program,
  visit: (call: Extract<Expression, { form: 'call' }>) => void,
): void {
  const expr = (node: Expression | undefined): void => {
    if (!node) {
      return
    }

    switch (node.form) {
      case 'call':
        visit(node)
        expr(node.callee)
        node.args.forEach(expr)
        break
      case 'binary':
        expr(node.left)
        expr(node.right)
        break
      case 'unary':
        expr(node.operand)
        break
      case 'member':
        expr(node.target)
        expr(node.index)
        break
      case 'await':
        expr(node.expr)
        break
      case 'array':
        node.items.forEach(expr)
        break
      case 'record':
        node.fields.forEach(f => expr(f.value))
        node.positional?.forEach(expr)
        break
      case 'map':
        node.entries.forEach(e => {
          expr(e.key)
          expr(e.value)
        })
        break
      case 'template':
        node.parts.forEach(p => (typeof p === 'string' ? undefined : expr(p)))
        break
      case 'closure':
        walk(node.body)
        break
      case 'conditional':
        node.branches.forEach(b => {
          expr(b.cond)
          expr(b.value)
        })
        expr(node.otherwise)
        break
      default:
        break
    }
  }

  const walk = (body: Statement[]): void => {
    for (const s of body) {
      switch (s.form) {
        case 'let':
          expr(s.init)
          break
        case 'assign':
          expr(s.target)
          expr(s.value)
          break
        case 'expression':
        case 'hold':
          expr(s.expr)
          break
        case 'return':
          expr(s.value)
          break
        case 'throw':
          expr(s.value)
          break
        case 'while':
          expr(s.cond)
          walk(s.body)
          break
        case 'for-each':
          expr(s.iterable)
          walk(s.body)
          break
        case 'if':
          s.branches.forEach(b => {
            expr(b.cond)
            walk(b.body)
          })
          walk(s.otherwise ?? [])
          break
        case 'match':
          expr(s.subject)
          s.cases.forEach(c => walk(c.body))
          walk(s.otherwise ?? [])
          break
        case 'guard':
          walk(s.body)
          walk(s.catch?.body ?? [])
          break
        case 'function':
          walk(s.body)
          break
        default:
          break
      }
    }
  }

  walk(program)
}

// the innermost call enclosing the position, with the active argument index, for signature help
export function callAt(
  program: Program,
  position: LspPosition,
): { name: string; activeParam: number } | undefined {
  let best:
    | { name: string; activeParam: number; span: Span }
    | undefined

  forEachCall(program, node => {
    if (!within(node.span, position) || node.callee.form !== 'variable') {
      return
    }

    // the active parameter is the count of arguments that begin before the cursor
    const activeParam = Math.max(
      0,
      node.args.filter(a => before(a.span, position)).length -
        (node.args.some(a => within(a.span, position)) ? 1 : 0),
    )

    if (!best || size(node.span) < size(best.span)) {
      best = {
        name: node.callee.name,
        activeParam,
        span: node.span,
      }
    }
  })

  return best
    ? { name: best.name, activeParam: best.activeParam }
    : undefined
}

// a compiler position as an LSP one (the two differ only in the column's name)
function lsp(p: { line: number; column: number }): LspPosition {
  return { line: p.line, character: p.column }
}

function size(span: Span): number {
  return (
    (span.end.line - span.start.line) * 100000 +
    (span.end.column - span.start.column)
  )
}

// is the position at or after the start of a span (a local is in scope once its declaration has begun)
function before(span: Span, p: LspPosition): boolean {
  return (
    p.line > span.start.line ||
    (p.line === span.start.line && p.character >= span.start.column)
  )
}
