// Reading `.tree` with the real parser.
//
// A manifest and a lockfile are ordinary `.tree` files, so they are parsed by
// `@term/make/code/parser/tree` like any other Term source, not by splitting lines
// and slicing prefixes. There is no dependency problem in doing so: the compiler does
// not import the package manager, so the package manager may import the compiler.
//
// The parser hands back a concrete syntax tree. This module flattens the part of it a
// manifest uses into one uniform shape:
//
//   deck @term/seed          -> { head: 'deck', terms: ['@term/seed'] }
//   code <0.0.4>             -> { head: 'code', value: '0.0.4' }
//   bear ./code              -> { head: 'bear', terms: ['./code'] }
//   link @term/bind, code <0.0.x>
//                            -> { head: 'link', terms: ['@term/bind'],
//                                 forms: [{ head: 'code', value: '0.0.x' }] }
//
// Indented children arrive as `forms` too, so a nested block reads the same way as an
// inline comma chain. Comments never appear: the parser keeps them as trivia on the
// group, so nothing here has to skip them.

import { parse } from '@term/make/code/parser/tree'
import type {
  GroupNode,
  RootNode,
} from '@term/make/code/parser/tree'
import type {
  Diagnostic,
  Position,
  Span,
} from '@term/make/code/parser/diagnostic'

// One head-led line and everything hanging off it.
export type Form = {
  head: string
  // bare-word arguments in order: a package name, a path, a keyword
  terms: string[]
  // the `<...>` value, when the line carries one
  value?: string
  // nested forms, whether written inline after a comma or indented beneath
  forms: Form[]
}

type Node = GroupNode['nodes'][number]

// The literal source text of a name or text node.
//
// Joining the chunks is NOT enough. `{...}` is interpolation in Term, so a glob like
// `~/book/**/{code,view}/**/*.tree` parses with `{code,view}` as an interpolation node,
// and dropping it silently mangles the pattern. A manifest is data: `{x}` in one means
// the characters `{x}`, not a substitution.
//
// So the text is recovered by slicing the ORIGINAL SOURCE across the node's full token
// extent, which reproduces whatever was written, interpolation-looking or not.
function literal(node: NodeLike, source: Source): string {
  const extent = tokenExtent(node)

  if (!extent) {
    return node.parts
      .map(part => (part.kind === 'chunk' ? (part.text ?? '') : ''))
      .join('')
  }

  return unescape(source.slice(extent.start, extent.end))
}

// `\{` and `\}` are how a literal brace is written, since a bare `{...}` is
// interpolation. The mill unescapes for code; a manifest reader has to as well, or a
// glob written `<./\{code,view\}>` comes back carrying its backslashes.
function unescape(text: string): string {
  return text.replace(/\\([<>{}\\])/g, '$1')
}

type NodeLike = {
  parts: ReadonlyArray<{ kind: string; text?: string }>
}

// the outermost token positions under a node, descending through interpolation groups so
// a trailing or leading `{...}` is included rather than clipped off
function tokenExtent(
  node: unknown,
): { start: Position; end: Position } | undefined {
  let start: Position | undefined
  let end: Position | undefined

  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') {
      return
    }

    const record = value as Record<string, unknown>
    const token = record['token'] as { span?: Span } | undefined

    if (token?.span) {
      if (!start || before(token.span.start, start)) {
        start = token.span.start
      }

      if (!end || before(end, token.span.end)) {
        end = token.span.end
      }
    }

    for (const key of ['parts', 'nodes']) {
      const list = record[key]

      if (Array.isArray(list)) {
        list.forEach(visit)
      }
    }

    visit(record['group'])
  }

  visit(node)

  return start && end ? { start, end } : undefined
}

function before(a: Position, b: Position): boolean {
  return a.line !== b.line ? a.line < b.line : a.column < b.column
}

// the source, indexed by line, so a span can be turned back into the text it covers
class Source {
  private lines: string[]

  constructor(text: string) {
    this.lines = text.split('\n')
  }

  slice(start: Position, end: Position): string {
    if (start.line === end.line) {
      return (this.lines[start.line] ?? '').slice(
        start.column,
        end.column,
      )
    }

    const out: string[] = [
      (this.lines[start.line] ?? '').slice(start.column),
    ]

    for (let line = start.line + 1; line < end.line; line++) {
      out.push(this.lines[line] ?? '')
    }

    out.push((this.lines[end.line] ?? '').slice(0, end.column))

    return out.join('\n')
  }
}

// A group is a bare TERM when it holds exactly one name and nothing else, which is how
// `bear ./code` carries `./code`. Anything richer is a nested form.
function isTerm(group: GroupNode): boolean {
  return group.nodes.length === 1 && group.nodes[0]?.kind === 'name'
}

function toForm(group: GroupNode, source: Source): Form | undefined {
  const first = group.nodes[0]

  if (first?.kind !== 'name') {
    return undefined
  }

  const form: Form = {
    head: literal(first, source),
    terms: [],
    forms: [],
  }

  for (const node of group.nodes.slice(1)) {
    readInto(form, node, source)
  }

  return form
}

function readInto(form: Form, node: Node, source: Source): void {
  switch (node.kind) {
    case 'text':
      form.value = literal(node, source)
      break

    case 'name':
      form.terms.push(literal(node, source))
      break

    case 'integer':
    case 'decimal':
    case 'radix':
      form.value = String(node.value)
      break

    case 'group': {
      if (isTerm(node)) {
        const only = node.nodes[0]

        if (only?.kind === 'name') {
          form.terms.push(literal(only, source))
        }

        return
      }

      const nested = toForm(node, source)

      if (nested) {
        form.forms.push(nested)
      }

      break
    }

    default:
      break
  }
}

// Parse `.tree` source into top-level forms. Returns the parser's own diagnostics on
// failure rather than inventing an error, so a malformed manifest reports with a span
// and a caret like every other Term error.
export function readTree(input: { file: string; text: string }):
  | { ok: true; forms: Form[] }
  | { ok: false; diagnostics: Diagnostic[] } {
  const result = parse({ file: input.file, text: input.text })

  if (!result.ok) {
    return { ok: false, diagnostics: result.diagnostics }
  }

  return { ok: true, forms: formsOf(result.tree, new Source(input.text)) }
}

function formsOf(tree: RootNode, source: Source): Form[] {
  const out: Form[] = []

  for (const group of tree.nodes) {
    const form = toForm(group, source)

    if (form) {
      out.push(form)
    }
  }

  return out
}

// the first nested form with this head
export function formOf(
  form: Form,
  head: string,
): Form | undefined {
  return form.forms.find(f => f.head === head)
}

// every nested form with this head
export function formsWith(form: Form, head: string): Form[] {
  return form.forms.filter(f => f.head === head)
}

// the `<...>` value of the first nested form with this head
export function valueOf(
  form: Form,
  head: string,
): string | undefined {
  return formOf(form, head)?.value
}

// the first bare-word argument of the first nested form with this head
export function termOf(
  form: Form,
  head: string,
): string | undefined {
  return formOf(form, head)?.terms[0]
}

// A COMMA CHAIN NESTS. `link @x, code <1.x.x>, have 1` does not put `code` and `have`
// side by side under `link`: each part becomes a child of the one before it, so `have`
// hangs off `code`. Search the whole chain rather than only the first level.
export function deepFormOf(
  form: Form,
  head: string,
): Form | undefined {
  for (const nested of form.forms) {
    if (nested.head === head) {
      return nested
    }

    const found = deepFormOf(nested, head)

    if (found) {
      return found
    }
  }

  return undefined
}

// the `<...>` value of the first form with this head anywhere in the chain
export function deepValueOf(
  form: Form,
  head: string,
): string | undefined {
  return deepFormOf(form, head)?.value
}

// The bare words a form carries, WITHOUT descending into its nested forms. Use this
// when a form has semantic children that must not be absorbed into its own value: a
// role's `take <glob>` has `miss` children, and `phraseOf` would swallow them.
export function termsOf(form: Form): string {
  return form.terms.join(' ')
}

// A MULTI-WORD VALUE BECOMES A NESTED GROUP. `task tsc` carries one term, but
// `task vitest run` parses as a `vitest` group holding `run`, because every word after
// the head reads as a head of its own. This walks the payload back into the phrase that
// was written, so `vitest run` comes back whole instead of truncated to `vitest`.
//
// This descends into EVERY nested form, so only use it where the form has no semantic
// children. Where it does, use `termsOf`.
export function phraseOf(form: Form): string {
  const words: string[] = [...form.terms]

  for (const nested of form.forms) {
    words.push(nested.head)

    const rest = phraseOf(nested)

    if (rest) {
      words.push(rest)
    }
  }

  return words.join(' ')
}
