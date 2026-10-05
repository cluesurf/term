// The Language Server itself: a message dispatcher over the LSP protocol. `dispatch` takes one incoming message and
// returns the outgoing messages (responses and notifications) to write back, so it is testable without any streams.
// The node entry point (main.ts) pumps stdin/stdout into it.
//
// WHAT IT COMPILES WITH IS WHAT `term make` COMPILES WITH. Diagnostics come from `compile()` (compile/compile.ts),
// given the same resolver, role, `mark lean` and deck readers the build passes (call/code/make.ts compileProject),
// so a file is an error in the editor exactly when it is an error in the build. The editor used to run its own
// per-definition pipeline (compile/analyzer.ts), which milled every file longhand, never bound names by import, and
// ran neither the `mark private` check nor the claim, effect and hold checks. A lean file showed a false error on
// nearly every line and a private task called from another file showed nothing.
//
// Every document holds:
//   its text and version, and the revision analyzed last
//   a VIEW of the last analysis: this file's own statements (typed when the compile succeeded, milled alone when it
//   did not, so navigation still works on a file with an error), the symbol index over them, span-free summaries
//   of the whole closure (signatures, top-level names, fields, methods), the diagnostics and the lint findings
// and nothing of the merged program itself, so what an open file costs is its own size plus the summaries.
//
// Analysis waits `debounce` milliseconds after the last edit, and any request about a document first settles it, so
// an answer is never about text the editor no longer shows. A request a handler cannot answer is answered with an
// error rather than taking the process down.

import type { Message } from '@term/flow/code/protocol'
import { hoverAt, toRange, toLspDiagnostic } from '@term/flow/code/analyze'
import type {
  LspDiagnostic,
  LspPosition,
  LspRange,
} from '@term/flow/code/analyze'
import { compile } from '@term/make/code/compile/compile'
import type { CompileResult } from '@term/make/code/compile/compile'
import { CompileCache } from '@term/make/code/compile/cache'
import { analyze as analyzeSource } from '@term/make/code/analyze'
import type { Finding } from '@term/make/code/lint/rule'
import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import {
  editorResolver,
  findModuleExporting,
  findProjectRoot,
  moduleCompletions,
  scanDefs,
} from '@term/make/code/resolve'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import { projectDeckOf } from '@term/call/code/deck-of'
import { projectResolver } from '@term/call/code/make'
import { withNativeEnv } from '@term/make/code/compile/native'
import { preprocessTests } from '@term/call/code/test-preprocess'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, relative, resolve as resolvePath } from 'node:path'
import { readFileSync } from 'node:fs'
import { parseTolerant } from '@term/make/code/parser/tree'
import { spanOfNode } from '@term/make/code/compile/mill-run'
import {
  buildIndex,
  callAt,
  findName,
  forEachCall,
  occurrencesOf,
  scopeAt,
  signaturesOf,
  symbolAt,
  writtenName,
} from '@term/flow/code/symbols'
import type {
  Named,
  SymbolIndex,
  SymbolKind,
} from '@term/flow/code/symbols'
import type { LoadHow, Resolver, Source } from '@term/make/code/compile/load'
import { declarationsOf, mentionAt, pathMentions, wordAt } from '@term/flow/code/paths'

// a path on disk, as opposed to an in-memory name a test resolver hands back
const isFilePath = (file: string): boolean => /^(?:[\\/]|[A-Za-z]:[\\/])/.test(file)
import type { Program, Statement } from '@term/make/code/compile/node'
import {
  IDENTITY,
  applyChange,
  foldingRanges,
  makeMapping,
  outerRange,
  selectionRange,
} from '@term/flow/code/text'
import type { ContentChange, Mapping } from '@term/flow/code/text'
import {
  Workspace,
  canonical,
  outerSpan,
} from '@term/flow/code/workspace'
import { showType } from '@term/make/code/compile/type-text'

type DeckOf = (file: string) => { name: string; root: string } | undefined

export type ServerOptions = {
  // an explicit resolver (tests). Otherwise each document gets its package's build resolver.
  resolve?: Resolver
  // explicit role and lean readers (tests). Otherwise each package's `role.tree` is read.
  roleOf?: (file: string) => string | null | undefined
  leanOf?: (file: string) => boolean | undefined
  deckOf?: DeckOf
  // milliseconds between the last edit and the analysis. 0 analyzes inside the `didChange` itself.
  debounce?: number
  // where a notification produced outside a request goes (a debounced publish). Without it, analysis is never
  // deferred: every `didOpen` / `didChange` analyzes at once and returns its publish from `dispatch`.
  send?: (message: Message) => void
}

// LSP SymbolKind / CompletionItemKind numeric codes for each of our kinds
const SYMBOL_KIND: Record<SymbolKind, number> = {
  function: 12,
  type: 10,
  variant: 22,
  trait: 11,
  parameter: 13,
  local: 13,
}

const COMPLETION_KIND: Record<SymbolKind, number> = {
  function: 3,
  type: 7,
  variant: 20,
  trait: 8,
  parameter: 6,
  local: 6,
}

const DEF_SYMBOL_KIND: Record<string, number> = {
  task: 12,
  form: 23,
  mask: 11,
  bind: 13,
}

// the keywords offered in completion: the four-letter Term vocabulary as written today. The retired words are not
// here and must never come back: `wave` (booleans are bare), `bust` and `send kink` (`halt` raises and passes on),
// `auto` (`seek`). Metadata is `mark` (`mark async`, `mark unsafe`, `mark private`), and `note <metadata>` is the old
// spelling, still read and warned about (`note-metadata`), so it is never offered. `note` stays a word for a field
// named note. `tick f(x)` starts an async task without waiting. A bare `back` is a return only in a lean file, so it
// is offered there and `send back` is offered everywhere else.
const KEYWORDS = [
  'task',
  'take',
  'send',
  'call',
  'read',
  'save',
  'host',
  'make',
  'bind',
  'form',
  'case',
  'head',
  'link',
  'slot',
  'need',
  'fork',
  'sift',
  'hook',
  'walk',
  'turn',
  'halt',
  'wait',
  'load',
  'find',
  'name',
  'mark',
  'text',
  'code',
  'like',
  'note',
  'hold',
  'dock',
  'mask',
  'wear',
  'suit',
  'fuse',
  'tree',
  'rule',
  'show',
  'seek',
  'have',
  'must',
  'down',
]

// statement-starting keywords scaffold their construct when accepted (LSP snippet syntax, insertTextFormat 2). Each
// is the shape the stdlib writes today: `walk list` binds its item under `hook next` as `take site, name <item>`, a
// guard's handler is a `halt take` beside `mark unsafe`, and a contract word takes one expression beneath it.
const SNIPPETS: Record<string, string> = {
  task: 'task ${1:name}\n  take ${2:arg}, like ${3:type}\n  like ${4:type}\n  send back\n    $0',
  form: 'form ${1:name}\n  link ${2:field}, like ${3:type}',
  mask: 'mask ${1:name}\n  task ${2:method}\n    take self\n    like ${3:type}',
  fork: 'fork test\n  hook test\n    $1\n  hook hold\n    $2\n  hook miss\n    $0',
  walk: 'walk list, read ${1:items}\n  hook next\n    take site, name ${2:item}\n    $0',
  // `sift <value>` is the match, `fork case, <value>` written short
  sift: 'sift read ${1:value}\n  case ${2:variant}\n    $0',
  wait: 'wait true',
  mark: 'mark ${1|async,unsafe,deprecated,stable,unstable,keep,draft,roam,open,private|}',
  have: 'have\n  $0',
  must: 'must\n  $0',
  down: 'down\n  $0',
}

// the lean spelling of the same constructs (note/term/lean.md): `back` returns, a fork's arms are `hold` / `miss`
// with no `hook`, and `walk <list>` / `take` iterates
const LEAN_SNIPPETS: Record<string, string> = {
  task: 'task ${1:name}\n  take ${2:arg}, like ${3:type}\n\n  like ${4:type}\n\n  back $0',
  fork: 'fork test\n  $1\n  hold\n    $2\n  miss\n    $0',
  walk: 'walk ${1:items}\n  take site, name ${2:item}\n  $0',
  sift: 'sift ${1:value}\n  case ${2:variant}\n    $0',
}

// phrases offered beside the single words, each a whole construct
const PHRASES: { label: string; insert: string; lean?: boolean; detail: string }[] = [
  { label: 'send back', insert: 'send back, $0', lean: false, detail: 'return a value' },
  { label: 'back', insert: 'back $0', lean: true, detail: 'return a value (lean)' },
  { label: 'mark async', insert: 'mark async', detail: 'this task is asynchronous' },
  { label: 'tick', insert: 'tick ${1:task}(${2})', detail: 'starts an async task and does not wait for it' },
  { label: 'halt kink', insert: 'halt kink', detail: "pass the callee's exception on" },
  {
    label: 'mark unsafe',
    insert: 'mark unsafe\n  $1\nhalt take\n  take ${2:error}\n  $0',
    detail: 'a guarded body and its handler',
  },
  { label: 'mark private', insert: 'mark private', detail: 'visible only in this file' },
]

// the old metadata spelling: `note <word>` still reads, but `mark <word>` is what gets offered
const RETIRED =
  /\bwave\b|\bbust\b|send kink|\bauto\b|\bnote (private|async|native|unsafe|stable|unstable|deprecated|keep|draft|roam|open|feature|platform)\b/

type Item = Record<string, unknown>

function keywordItems(lean: boolean): Item[] {
  const items: Item[] = []

  for (const label of KEYWORDS) {
    const snippet = (lean ? LEAN_SNIPPETS[label] : undefined) ?? SNIPPETS[label]

    // keywords sort last (prefix `3`), after scope symbols and imported names
    items.push(
      snippet
        ? { label, kind: KIND_KEYWORD, insertText: snippet, insertTextFormat: 2, sortText: `3${label}` }
        : { label, kind: KIND_KEYWORD, sortText: `3${label}` },
    )
  }

  for (const phrase of PHRASES) {
    if (phrase.lean !== undefined && phrase.lean !== lean) {
      continue
    }

    items.push({
      label: phrase.label,
      kind: phrase.insert.includes('$') ? KIND_SNIPPET : KIND_KEYWORD,
      detail: phrase.detail,
      insertText: phrase.insert,
      insertTextFormat: 2,
      sortText: `3${phrase.label}`,
    })
  }

  // a guard against a retired word coming back through an edit to the tables above
  return items.filter(item => !RETIRED.test(`${item.label} ${item.insertText ?? ''}`))
}

// the hover popover as markdown. A definition under the cursor renders its full signature (a call shows
// `greet(name: text) -> text`, a form / mask its head + members); any other expression renders its inferred type. The
// `tree` fence (the language id this extension registers) lets the editor syntax-color the popover.
function hoverMarkdown(
  def: { name: string; kind: SymbolKind; detail: string } | undefined,
  type: string | undefined,
  note?: string,
): string | undefined {
  if (def) {
    const name = writtenName(def.name)
    const value =
      def.kind === 'local' || def.kind === 'parameter'
        ? `${name}: ${def.detail}`
        : `${name}${def.detail}`

    // the definition's doc comment under its signature, as prose
    return '```tree\n' + value + '\n```' + (note ? `\n\n${note}` : '')
  }

  if (type) {
    return '```tree\n' + type + '\n```'
  }

  return undefined
}

// the on-disk path of a `file:` uri, or undefined
function pathFor(uri: string): string | undefined {
  if (!uri.startsWith('file:')) {
    return undefined
  }

  try {
    return fileURLToPath(uri)
  } catch {
    return undefined
  }
}

function uriFor(file: string): string {
  return file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file) ? pathToFileURL(file).href : file
}

// the `load @scope/pkg/...` whose block contains the given line (a `find` is indented under its `load`), or undefined
function enclosingLoad(
  text: string,
  lineNumber: number,
): string | undefined {
  const lines = text.split('\n')

  for (let i = lineNumber - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    const match = /^(?:load|bear)\s+(\S+)/.exec(line)

    if (match) {
      return match[1]
    }

    // a non-empty column-0 line that is not the `load` ends the block
    if (/^\S/.test(line) && line.trim() !== '') {
      return undefined
    }
  }

  return undefined
}

// the identifier inside an LSP range (a diagnostic's range), or undefined
function nameInRange(text: string, range: LspRange): string | undefined {
  const line = text.split('\n')[range.start.line] ?? ''
  const slice = line.slice(range.start.character, range.end.character)

  return /[a-z][A-Za-z0-9-]*/.exec(slice.trim().replace(/^(?:call|read|make)\s+/, ''))?.[0]
}

// the edit that imports `name` from `importPath`: a `find` under an existing `load` of that module, else a new load
// block prepended to the file
function importEdit(
  text: string,
  importPath: string,
  name: string,
): { range: LspRange; newText: string } {
  const lines = text.split('\n')
  const at = lines.findIndex(l => l.startsWith(`load ${importPath}`))

  if (at >= 0) {
    return {
      range: {
        start: { line: at + 1, character: 0 },
        end: { line: at + 1, character: 0 },
      },
      newText: `  find ${name}\n`,
    }
  }

  return {
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    },
    newText: `load ${importPath}\n  find ${name}\n\n`,
  }
}

// semantic tokens: precise identifier coloring the TextMate grammar cannot do (a function call vs a type vs a local).
// The legend order is fixed; `tokenModifiers` has only `declaration`.
const SEMANTIC_TOKEN_TYPES = [
  'function',
  'type',
  'interface',
  'parameter',
  'variable',
]

// a definition kind -> token type index
const KIND_TOKEN: Record<SymbolKind, number> = {
  function: 0,
  type: 1,
  variant: 1,
  trait: 2,
  parameter: 3,
  local: 4,
}

// Every token is a NAME span: a definition's name where it is declared, and a reference's name where it is used,
// colored by what it resolves to (a parameter or local of the enclosing task first, then a top-level definition).
// Never a whole expression: the compiler's span for `call helper` covers the call and its arguments.
export function semanticTokens(
  text: string,
  index: SymbolIndex,
  map: Mapping = IDENTITY,
): { data: number[] } {
  type Token = {
    line: number
    char: number
    length: number
    type: number
    mod: number
  }
  const tokens: Token[] = []

  const push = (span: Span | undefined, type: number, mod: number): void => {
    if (!span || span.start.line !== span.end.line) {
      return
    }

    const start = map.outer({ line: span.start.line, character: span.start.column }, 'start')
    const end = map.outer({ line: span.end.line, character: span.end.column }, 'end')

    if (start.line !== end.line || end.character <= start.character) {
      return
    }

    tokens.push({ line: start.line, char: start.character, length: end.character - start.character, type, mod })
  }

  // an index built without the text has no name spans; find them here rather than color nothing
  const lines = text.split('\n')
  const nameOf = (at: Span | undefined, span: Span, name: string): Span | undefined =>
    at ?? findName(lines, span, name)

  for (const def of index.definitions.values()) {
    push(nameOf(def.at, def.span, def.name), KIND_TOKEN[def.kind], 1)
  }

  for (const scope of index.scopes) {
    for (const local of scope.locals) {
      push(local.at, KIND_TOKEN[local.kind], 1)
    }
  }

  for (const ref of index.references) {
    const scope = index.scopes.find(
      s =>
        (s.span.start.line < ref.span.start.line ||
          (s.span.start.line === ref.span.start.line && s.span.start.column <= ref.span.start.column)) &&
        (s.span.end.line > ref.span.start.line ||
          (s.span.end.line === ref.span.start.line && s.span.end.column >= ref.span.start.column)),
    )

    const local = scope?.locals.find(l => l.name === ref.name)
    const kind = local?.kind ?? index.definitions.get(ref.name)?.kind

    push(nameOf(ref.at, ref.span, ref.name), kind ? KIND_TOKEN[kind] : 4, 0)
  }

  tokens.sort((a, b) => a.line - b.line || a.char - b.char)

  // delta-encode (LSP), skipping a token that overlaps one already emitted
  const data: number[] = []

  let prevLine = 0
  let prevChar = 0
  let prevEnd = -1
  let first = true

  for (const t of tokens) {
    if (!first && t.line === prevLine && t.char < prevEnd) {
      continue
    }

    const deltaLine = first ? t.line : t.line - prevLine
    const deltaChar = first || deltaLine > 0 ? t.char : t.char - prevChar

    data.push(deltaLine, deltaChar, t.length, t.type, t.mod)
    prevLine = t.line
    prevChar = t.char
    prevEnd = t.char + t.length
    first = false
  }

  return { data }
}

// inlay hints. Two kinds:
//   a TYPE after a `save x` / `host x` with no `, like` annotation (`: <type>`), in every file
//   a PARAMETER NAME before each positional argument of a call in a LEAN file, where an argument is written
//   `f(a, b)` or as a bare line under the call, with nothing saying which parameter it fills
type InlayHint = {
  position: { line: number; character: number }
  label: string
  kind: number
  paddingLeft?: boolean
  paddingRight?: boolean
}

export function inlayHints(
  program: Program,
  text: string,
  range: { start: { line: number }; end: { line: number } },
  options?: {
    lean?: boolean
    signatures?: SymbolIndex['signatures']
  },
): InlayHint[] {
  const lines = text.split('\n')
  const hints: InlayHint[] = []
  const inRange = (line: number): boolean => line >= range.start.line && line <= range.end.line

  const visitLet = (
    node: Extract<Statement, { form: 'let' }>,
  ): void => {
    const line = node.span.start.line

    if (!inRange(line)) {
      return
    }

    const src = lines[line] ?? ''

    // an explicitly annotated binding (`save x, like number`) needs no hint
    if (
      /^\s*(?:save|host)\s+[a-z][A-Za-z0-9-]*\s*,\s*like\b/.test(src)
    ) {
      return
    }

    const match = /^(\s*(?:save|host)\s+)([a-z][A-Za-z0-9-]*)/.exec(src)
    const type = node.init.type ?? node.type

    if (!match || !type || type.kind === 'unknown') {
      return
    }

    hints.push({
      position: {
        line,
        character: match[1]!.length + match[2]!.length,
      },
      label: `: ${showType(type)}`,
      kind: 1, // Type
      paddingLeft: true,
    })
  }

  const walk = (statements: Statement[]): void => {
    for (const node of statements) {
      switch (node.form) {
        case 'let':
          visitLet(node)
          break
        case 'function':
        case 'while':
        case 'for-each':
          walk(node.body)
          break
        case 'guard':
          walk(node.body)
          walk(node.catch?.body ?? [])
          break
        case 'if':
          node.branches.forEach(b => walk(b.body))

          if (node.otherwise) {
            walk(node.otherwise)
          }

          break
        case 'match':
          node.cases.forEach(c => walk(c.body))

          if (node.otherwise) {
            walk(node.otherwise)
          }

          break
        default:
          break
      }
    }
  }

  walk(program)

  if (options?.lean && options.signatures) {
    const signatures = options.signatures

    forEachCall(program, call => {
      if (call.callee.form !== 'variable') {
        return
      }

      const sig = signatures.get(call.callee.name)

      if (!sig || sig.params.length < 2) {
        // one parameter has nothing to tell apart
        return
      }

      call.args.forEach((arg, i) => {
        const param = sig.params[i]
        const at = arg.span.start

        if (
          !param ||
          (arg.span.file !== undefined && arg.span.file !== call.span.file) ||
          !inRange(at.line) ||
          // an argument outside the call's own text was filled in (a `fall` default), not written
          at.line < call.span.start.line ||
          at.line > call.span.end.line ||
          (at.line === call.span.start.line && at.column <= call.span.start.column)
        ) {
          return
        }

        const before = (lines[at.line] ?? '').slice(0, at.column)

        // a named argument already says its name, and an argument that IS the parameter's name says it too
        if (
          new RegExp(`(?:^|[\\s(,])(?:bind\\s+)?${escape(param.name)}\\s*,?\\s*$`).test(before) ||
          (arg.form === 'variable' && arg.name === param.name)
        ) {
          return
        }

        // a text literal's span starts inside its `<`: the hint goes before the bracket
        const column = (lines[at.line] ?? '')[at.column - 1] === '<' ? at.column - 1 : at.column

        hints.push({
          position: { line: at.line, character: column },
          label: `${param.name}:`,
          kind: 2, // Parameter
          paddingRight: true,
        })
      })
    })
  }

  return hints
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// LSP CompletionItemKind values used here
const KIND_METHOD = 2
const KIND_FIELD = 5
const KIND_MODULE = 9
const KIND_KEYWORD = 14
const KIND_SNIPPET = 15
const KIND_FOLDER = 19
const EXPORT_KIND: Record<string, number> = {
  task: 3, // Function
  form: 22, // Struct
  mask: 8, // Interface
  bind: 3,
}

// the receiver name in a `<receiver>/<partial>` member access ending at the cursor, or undefined
function memberReceiver(lineBeforeCursor: string): string | undefined {
  return /([A-Za-z][A-Za-z0-9-]*)\/[A-Za-z0-9-]*$/.exec(
    lineBeforeCursor,
  )?.[1]
}

// the leading type name of a `detail` string (`point` from `point`, `list` from `list<number>`)
function leadingName(detail: string): string | undefined {
  return /^[A-Za-z][A-Za-z0-9-]*/.exec(detail)?.[0]
}

// a function statement's signature, for a method's completion detail
function signatureOf(
  fn: Extract<Program[number], { form: 'function' }>,
): string {
  const params = fn.params
    .map(p => `${p.name}: ${showType(p.type ?? { kind: 'unknown' })}`)
    .join(', ')

  return `(${params}) -> ${showType(fn.result ?? { kind: 'unit' })}`
}

// span-free facts about the whole closure, kept when the merged program itself is dropped
type Summary = {
  signatures: SymbolIndex['signatures']
  // the top-level, bare-callable definitions: functions, forms, masks (imported names for completion)
  topLevel: { name: string; kind: number; detail: string }[]
  fields: Map<string, { name: string; type: string }[]>
  methods: Map<string, { name: string; detail: string }[]>
}

function summarize(program: Program): Summary {
  const topLevel: Summary['topLevel'] = []
  const fields: Summary['fields'] = new Map()
  const methods: Summary['methods'] = new Map()

  for (const statement of program) {
    if (statement.form === 'function' && !statement.method) {
      topLevel.push({ name: statement.name, kind: 3, detail: signatureOf(statement) })
    } else if (statement.form === 'function' && statement.method) {
      const list = methods.get(statement.method.form) ?? []
      list.push({ name: statement.method.name, detail: signatureOf(statement) })
      methods.set(statement.method.form, list)
    } else if (statement.form === 'record-type') {
      topLevel.push({ name: statement.name, kind: statement.variants.length ? 13 : 22, detail: 'form' })
      fields.set(
        statement.name,
        statement.fields.map(f => ({ name: f.name, type: showType(f.type) })),
      )
    } else if (statement.form === 'mask') {
      topLevel.push({ name: statement.name, kind: 8, detail: 'mask' })
    }
  }

  return { signatures: signaturesOf(program), topLevel, fields, methods }
}

// `over` wins where both name a thing
function mergeSummary(under: Summary, over: Summary): Summary {
  const names = new Set(over.topLevel.map(t => t.name))

  return {
    signatures: new Map([...under.signatures, ...over.signatures]),
    topLevel: [...under.topLevel.filter(t => !names.has(t.name)), ...over.topLevel],
    fields: new Map([...under.fields, ...over.fields]),
    methods: new Map([...under.methods, ...over.methods]),
  }
}

const EMPTY_SUMMARY: Summary = {
  signatures: new Map(),
  topLevel: [],
  fields: new Map(),
  methods: new Map(),
}

type View = {
  // the text the compiler read (a test file's after its `test` blocks are rewritten) and the mapping back
  inner: string
  map: Mapping
  // this document's own statements: typed when the compile succeeded, milled alone when it did not
  program: Program
  typed: boolean
  index: SymbolIndex
  summary: Summary
  diagnostics: LspDiagnostic[]
  findings: Finding[]
  lean: boolean
  role?: string
}

type Doc = {
  uri: string
  // the file the compiler is told about: the real path for a `file:` uri, the uri itself otherwise
  file: string
  path?: string
  text: string
  version: number
  // bumped on every text change; `analyzed` is the revision the view was built from
  revision: number
  analyzed: number
  // a dependency changed since the view was built
  stale: boolean
  timer?: ReturnType<typeof setTimeout>
  view?: View
  // the files the last compile read, for refreshing this document when one of them changes
  closure: Set<string>
  // the import path each directly loaded file was reached by, for placing an error found inside it
  direct: Map<string, string>
  // the serialized diagnostics last published, and a result id that changes only when they do
  published?: string
  resultId: number
  tokens?: { id: string; data: number[] }
}

class ParamsError extends Error {}

// the codes a JSON-RPC error carries (the LSP's own, beside the protocol's)
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603
const REQUEST_CANCELLED = -32800

function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new ParamsError(`missing ${what}`)
  }

  return value
}

function positionOf(params: unknown): LspPosition {
  const p = (params as { position?: LspPosition } | null)?.position

  if (!p || typeof p.line !== 'number' || typeof p.character !== 'number') {
    throw new ParamsError('missing or malformed position')
  }

  return { line: Math.max(0, p.line), character: Math.max(0, p.character) }
}

function uriOf(params: unknown): string {
  const uri = (params as { textDocument?: { uri?: unknown } } | null)?.textDocument?.uri

  if (typeof uri !== 'string') {
    throw new ParamsError('missing textDocument.uri')
  }

  return uri
}

export class LanguageServer {
  private readonly documents = new Map<string, Doc>()
  // an open document by the file it is, so an import of it reads the editor's text rather than the disk's
  private readonly byFile = new Map<string, Doc>()
  // ONE mill and output cache for every document, capped (compile/cache.ts): a module the open files share is milled
  // once, and nothing grows with the session
  private readonly cache = new CompileCache()
  private readonly options: ServerOptions
  private readonly readersByRoot = new Map<
    string,
    { roleOf: (file: string) => string | null; leanOf: (file: string) => boolean }
  >()

  private deckOf: DeckOf = projectDeckOf()
  private readonly cancelled = new Set<number | string>()
  private readonly workspace: Workspace
  private shuttingDown = false
  // the client pulls diagnostics (`textDocument/diagnostic`), so none are pushed
  private pull = false
  private tokenCounter = 0

  constructor(options?: Resolver | ServerOptions) {
    this.options =
      typeof options === 'function' ? { resolve: options } : (options ?? {})

    this.workspace = new Workspace({
      textOf: file => this.byFile.get(file)?.text,
      readersOf: file => {
        const readers = this.readersFor(file)

        return {
          role: readers.roleOf?.(file) ?? undefined,
          lean: readers.leanOf?.(file) ?? false,
        }
      },
      // through `resolveModule`, the one place a path becomes a file, from any file of the package
      resolverOf: () => (path, from) => this.resolveModule(this.byFile.get(from) ?? this.fileDoc(from), path),
    })
  }

  isShutDown(): boolean {
    return this.shuttingDown
  }

  // what the server holds, for a test that a closed document is released
  held(): { documents: number; files: number; timers: number } {
    return {
      documents: this.documents.size,
      files: this.byFile.size,
      timers: [...this.documents.values()].filter(d => d.timer !== undefined).length,
    }
  }

  // a `$/cancelRequest`, read as it arrives. The request is answered RequestCancelled when its turn comes.
  cancel(id: number | string | undefined | null): void {
    if (id !== undefined && id !== null) {
      this.cancelled.add(id)
    }
  }

  // the role, lean and deck readers for a file, read from its package once
  private readersFor(file: string): {
    roleOf?: (file: string) => string | null | undefined
    leanOf?: (file: string) => boolean | undefined
    root?: string
  } {
    const root = file.startsWith('file:') || !/^[\\/]|^[A-Za-z]:/.test(file) ? undefined : findProjectRoot(file)

    if (this.options.roleOf || this.options.leanOf) {
      return { roleOf: this.options.roleOf, leanOf: this.options.leanOf, root }
    }

    if (!root) {
      return {}
    }

    let readers = this.readersByRoot.get(root)

    if (!readers) {
      readers = { roleOf: projectRoleOf(root), leanOf: projectLeanOf(root) }
      this.readersByRoot.set(root, readers)
    }

    return { ...readers, root }
  }

  // the resolver one analysis uses: the package's build resolver, made fresh so a file changed on disk is read again,
  // with every open document's text in place of its file's
  private resolverFor(doc: Doc, root: string | undefined): Resolver | undefined {
    let base: Resolver | undefined = this.options.resolve

    // a file outside every package, and a buffer with no file at all (`untitled:`), still resolve the stdlib, with its
    // `{platform}` slots filled for node as `projectResolver` fills them. Unfilled, every module a test file's harness
    // loads reported its native names (`generate-v4`, `bit-and`) as undefined
    if (!base) {
      try {
        base = root ? projectResolver(root) : withNativeEnv('node', editorResolver(doc.path ?? '/'))
      } catch {
        base = undefined
      }
    }

    if (!base) {
      return undefined
    }

    const resolve = base
    doc.closure = new Set()
    doc.direct = new Map()

    return (importPath: string, from: string, how?: LoadHow): Source | undefined => {
      // a relative load the disk cannot answer may name a file open in the editor and not yet saved: the resolver asks
      // the disk whether a file exists, so a new file could not be loaded by path until it was saved (basics/editor)
      const found = resolve(importPath, from, how) ?? this.unsavedAt(importPath, from)

      if (!found) {
        return undefined
      }

      doc.closure.add(found.file)

      if (from === doc.file && !doc.direct.has(found.file)) {
        doc.direct.set(found.file, importPath)
      }

      const open = this.byFile.get(found.file)

      return open && open !== doc ? { file: found.file, text: open.text } : found
    }
  }

  // an open document at one of the paths a relative load tries, in the resolver's order (`x.tree`, `x/base.tree`,
  // `x/note.tree`), for a file the disk does not hold yet
  private unsavedAt(importPath: string, from: string): Source | undefined {
    if (!importPath.startsWith('./') && !importPath.startsWith('../')) {
      return undefined
    }

    const base = resolvePath(dirname(from), importPath)

    for (const candidate of [`${base}.tree`, join(base, 'base.tree'), join(base, 'note.tree')]) {
      const open = this.byFile.get(candidate)

      if (open) {
        return { file: candidate, text: open.text }
      }
    }

    return undefined
  }

  // ---- analysis ----

  // compile one document as the build would and keep what the editor needs from it
  private analyzeNow(doc: Doc): void {
    const readers = this.readersFor(doc.file)
    const role = readers.roleOf?.(doc.file) ?? undefined
    const lean = readers.leanOf?.(doc.file) ?? false

    // a file of `test` blocks is compiled the way `term make` and `term test` compile it, rewritten into tasks
    let inner = doc.text
    let map: Mapping = IDENTITY

    // only a file read as code is rewritten: a view document, a data file and a mill definition each have their
    // own reader, and a `test` head in one of those is that dialect's business
    if (role !== 'view' && role !== 'host' && role !== 'mill' && /^\s*test /m.test(doc.text)) {
      const rewritten = preprocessTests(doc.text)
      inner = rewritten.text
      map = makeMapping(doc.text, inner, rewritten.origin)
    }

    const resolve = this.resolverFor(doc, readers.root)

    let result: CompileResult | undefined
    let fault: unknown

    try {
      result = compile(
        { file: doc.file, text: inner },
        {
          resolve,
          cache: this.cache,
          roleOf: readers.roleOf,
          leanOf: readers.leanOf,
          deckOf: this.options.deckOf ?? this.deckOf,
          // the editor needs every call site intact for navigation, not the inlined, specialized shape
          optimize: false,
        },
      )
    } catch (error) {
      fault = error
    }

    const diagnostics: LspDiagnostic[] = []

    if (fault !== undefined) {
      diagnostics.push({
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        severity: 1,
        code: 'compiler-fault',
        source: 'term',
        message: `the compiler failed on this file: ${(fault as Error)?.message ?? String(fault)}`,
      })
    } else if (result) {
      const found = result.ok ? result.warnings : result.diagnostics

      for (const d of found) {
        const placed = this.place(d, doc, map)

        if (placed) {
          diagnostics.push(placed)
        }
      }
    }

    // this file alone, milled with its role and lean flag: the lint engine's input, and the navigation program when
    // the compile did not produce one. The author's text, since lint findings carry fixes against it.
    let findings: Finding[] = []
    let milled: Program | null = null

    try {
      const local = analyzeSource({ file: doc.file, text: doc.text }, { role, lean })
      milled = local.program
      findings = local.lint()
    } catch {
      findings = []
    }

    for (const finding of findings) {
      diagnostics.push({
        range: toRange(finding.span),
        severity: finding.severity === 'error' ? 1 : finding.severity === 'warning' ? 2 : 3,
        code: finding.code,
        source: 'term lint',
        message: finding.message,
        ...(finding.fix ? { data: { fix: true } } : {}),
      })
    }

    let program: Program
    let typed = false
    let summary = doc.view?.summary ?? EMPTY_SUMMARY

    if (result?.ok) {
      program = result.program.filter(s => s.span.file === doc.file)
      typed = true
      summary = summarize(result.program)
    } else if (map.identity && milled) {
      program = milled
    } else {
      // a test file whose compile failed: the rewritten text milled alone, in the coordinates `map` expects
      try {
        program = analyzeSource({ file: doc.file, text: inner }, { role, lean }).program ?? []
      } catch {
        program = []
      }
    }

    // a failed compile keeps the last good closure summary, with this file's own forms and tasks laid over it, so a
    // record declared here still completes its fields while a line below it is half written
    if (!typed) {
      summary = mergeSummary(summary, summarize(program))
    }

    const index = buildIndex(program, inner)

    // whole-closure signatures (span-free), so signature help and argument ranking work for imported tasks
    for (const [name, sig] of summary.signatures) {
      if (!index.signatures.has(name)) {
        index.signatures.set(name, sig)
      }
    }

    doc.view = { inner, map, program, typed, index, summary, diagnostics, findings, lean, role }
    doc.analyzed = doc.revision
    doc.stale = false
  }

  // a compiler diagnostic, placed in this document. One in this file maps through the test rewrite; one inside an
  // imported module (which is how a broken dependency fails this file's compile) is shown on the `load` that reached
  // it, naming the file and line, with the location itself as related information.
  private place(d: Diagnostic, doc: Doc, map: Mapping): LspDiagnostic | undefined {
    // the span says which module the error is IN; `file` is often the entry the compile was asked about
    const file = d.span.file || d.file

    if (!file || file === doc.file || file === doc.uri) {
      const lsp = toLspDiagnostic(d)

      return { ...lsp, range: outerRange(map, lsp.range), data: { name: d.name } }
    }

    // an imported module's warning is that module's business
    if (d.severity !== 'error') {
      return undefined
    }

    const lines = doc.text.split('\n')
    const importPath = doc.direct.get(file)
    const at = importPath
      ? lines.findIndex(l => new RegExp(`^(?:load|bear)\\s+${escape(importPath)}\\s*$`).test(l))
      : -1
    const line = at >= 0 ? at : Math.max(0, lines.findIndex(l => /^(?:load|bear)\s/.test(l)))
    const shown = file.startsWith('/') && doc.path ? relative(doc.path.replace(/[^/]+$/, ''), file) : file
    const lsp = toLspDiagnostic(d)

    return {
      ...lsp,
      range: { start: { line, character: 0 }, end: { line, character: (lines[line] ?? '').length } },
      message: `${shown}:${d.span.start.line + 1}: ${lsp.message}`,
      data: { name: d.name },
      ...(file.startsWith('/')
        ? {
            relatedInformation: [
              { location: { uri: uriFor(file), range: toRange(d.span) }, message: d.message },
            ],
          }
        : {}),
    }
  }

  // the publish for a document, or nothing when its diagnostics are what was last sent (backdating), or when the
  // client pulls them instead
  private publish(doc: Doc): Message | undefined {
    const diagnostics = doc.view?.diagnostics ?? []
    const key = JSON.stringify(diagnostics)

    if (doc.published === key) {
      return undefined
    }

    doc.published = key
    doc.resultId++

    if (this.pull) {
      return undefined
    }

    return notify('textDocument/publishDiagnostics', {
      uri: doc.uri,
      version: doc.version,
      diagnostics,
    })
  }

  // analyze a document if its view is behind its text, then the open documents that import it (when `cascade`),
  // and return the publishes that produced
  private run(doc: Doc, cascade: boolean): Message[] {
    if (!this.documents.has(doc.uri) || this.documents.get(doc.uri) !== doc) {
      return []
    }

    if (doc.timer) {
      clearTimeout(doc.timer)
      doc.timer = undefined
    }

    const out: Message[] = []

    if (doc.analyzed !== doc.revision || doc.stale || !doc.view) {
      this.analyzeNow(doc)

      const note = this.publish(doc)

      if (note) {
        out.push(note)
      }
    }

    if (cascade) {
      for (const other of this.documents.values()) {
        if (other === doc || !other.closure.has(doc.file)) {
          continue
        }

        other.stale = true

        if (this.deferred()) {
          this.schedule(other)
        } else {
          out.push(...this.run(other, false))
        }
      }
    }

    return out
  }

  private deferred(): boolean {
    return this.options.send !== undefined && (this.options.debounce ?? 0) > 0
  }

  // analyze after the debounce, publishing through `send`
  private schedule(doc: Doc, cascade = false): void {
    if (doc.timer) {
      clearTimeout(doc.timer)
    }

    doc.timer = setTimeout(() => {
      doc.timer = undefined

      try {
        for (const message of this.run(doc, cascade)) {
          this.options.send?.(message)
        }
      } catch (error) {
        this.options.send?.(logMessage(`analysis failed for ${doc.uri}: ${String((error as Error)?.message ?? error)}`))
      }
    }, this.options.debounce ?? 0)
  }

  // the document a request names, brought up to date first so the answer is about the text the editor shows
  private settled(params: unknown, outbox: Message[]): Doc | undefined {
    const doc = this.documents.get(uriOf(params))

    if (!doc) {
      return undefined
    }

    if (doc.timer || doc.analyzed !== doc.revision || doc.stale || !doc.view) {
      outbox.push(...this.run(doc, doc.timer !== undefined))
    }

    return doc
  }

  private open(uri: string, text: string, version: number): Doc {
    const path = pathFor(uri)
    const file = path ? canonical(path) : uri
    const doc: Doc = {
      uri,
      file,
      path,
      text,
      version,
      revision: 0,
      analyzed: -1,
      stale: false,
      closure: new Set(),
      direct: new Map(),
      resultId: 0,
    }

    this.close(uri)
    this.documents.set(uri, doc)

    if (path) {
      this.byFile.set(file, doc)
    }

    return doc
  }

  // forget a document entirely: its text, its view, its timer
  private close(uri: string): void {
    const doc = this.documents.get(uri)

    if (!doc) {
      return
    }

    if (doc.timer) {
      clearTimeout(doc.timer)
    }

    this.documents.delete(uri)

    if (this.byFile.get(doc.file) === doc) {
      this.byFile.delete(doc.file)
    }
  }

  // ---- the dispatcher ----

  async dispatch(message: Message): Promise<Message[]> {
    const outbox: Message[] = []

    if (message.method === '$/cancelRequest') {
      this.cancel((message.params as { id?: number | string } | null)?.id)

      return []
    }

    if (message.id !== undefined && message.id !== null && this.cancelled.has(message.id)) {
      this.cancelled.delete(message.id)

      return [{ jsonrpc: '2.0', id: message.id, error: { code: REQUEST_CANCELLED, message: 'cancelled' } }]
    }

    // a response from the client (to a request this server never sends) has no method: nothing to do
    if (message.method === undefined) {
      return []
    }

    try {
      const answer = this.handle(message, outbox)

      return [...outbox, ...answer]
    } catch (error) {
      const text = String((error as Error)?.message ?? error)

      if (message.id !== undefined && message.id !== null) {
        return [
          ...outbox,
          {
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: error instanceof ParamsError ? INVALID_PARAMS : INTERNAL_ERROR,
              message: `${message.method}: ${text}`,
            },
          },
        ]
      }

      // a notification has no one to answer, so the client's log hears about it
      return [...outbox, logMessage(`${message.method}: ${text}`)]
    }
  }

  private handle(message: Message, outbox: Message[]): Message[] {
    const params = message.params

    switch (message.method) {
      case 'initialize': {
        const caps = (params as { capabilities?: Record<string, unknown> } | null)?.capabilities ?? {}
        const textDocument = (caps.textDocument ?? {}) as Record<string, unknown>
        const general = (caps.general ?? {}) as { positionEncodings?: string[] }

        this.pull = textDocument.diagnostic !== undefined

        return [
          respond(message, {
            capabilities: {
              // every column is a UTF-16 code unit (text.ts), which is the protocol's default and the only
              // encoding this server speaks; said explicitly to a client that offered a choice
              ...(general.positionEncodings ? { positionEncoding: 'utf-16' } : {}),
              textDocumentSync: { openClose: true, change: 2, save: { includeText: false } },
              hoverProvider: true,
              definitionProvider: true,
              implementationProvider: true,
              referencesProvider: true,
              renameProvider: { prepareProvider: true },
              documentSymbolProvider: true,
              documentLinkProvider: { resolveProvider: false },
              workspaceSymbolProvider: true,
              documentHighlightProvider: true,
              foldingRangeProvider: true,
              selectionRangeProvider: true,
              callHierarchyProvider: true,
              completionProvider: { triggerCharacters: [' ', '/'] },
              signatureHelpProvider: { triggerCharacters: [' ', '(', ','] },
              codeActionProvider: { codeActionKinds: ['quickfix', 'source.fixAll'] },
              codeLensProvider: { resolveProvider: false },
              inlayHintProvider: true,
              semanticTokensProvider: {
                legend: {
                  tokenTypes: SEMANTIC_TOKEN_TYPES,
                  tokenModifiers: ['declaration'],
                },
                full: { delta: true },
              },
              ...(this.pull
                ? { diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false } }
                : {}),
            },
            serverInfo: { name: 'term-flow' },
          }),
        ]
      }

      case 'initialized':
        return []

      case 'shutdown':
        this.shuttingDown = true

        for (const uri of [...this.documents.keys()]) {
          this.close(uri)
        }

        return [respond(message, null)]

      case 'exit':
        return []

      case 'textDocument/didOpen': {
        const item = need((params as { textDocument?: { uri?: string; text?: string; version?: number } } | null)?.textDocument, 'textDocument')
        const doc = this.open(need(item.uri, 'textDocument.uri'), item.text ?? '', item.version ?? 0)

        // an opened file is analyzed at once: there is no burst of typing to wait out
        return this.run(doc, true)
      }

      case 'textDocument/didChange': {
        const change = params as {
          textDocument?: { uri?: string; version?: number }
          contentChanges?: ContentChange[]
        } | null
        const doc = this.documents.get(uriOf(change))

        if (!doc) {
          return []
        }

        for (const each of change?.contentChanges ?? []) {
          doc.text = applyChange(doc.text, each)
        }

        doc.version = change?.textDocument?.version ?? doc.version + 1
        doc.revision++

        if (this.deferred()) {
          this.schedule(doc, true)

          return []
        }

        return this.run(doc, true)
      }

      case 'textDocument/didSave':
        return []

      case 'textDocument/didClose': {
        const uri = uriOf(params)
        const had = this.documents.has(uri)
        this.close(uri)

        return had && !this.pull
          ? [notify('textDocument/publishDiagnostics', { uri, diagnostics: [] })]
          : []
      }

      case 'workspace/didChangeWatchedFiles': {
        // a file created, changed or deleted on disk: a package's file list, its role files and its deck names may
        // all be different now, and every open document that read the file must be analyzed again
        const changes = ((params as { changes?: { uri: string; type: number }[] } | null)?.changes ?? [])
        const files = new Set(changes.map(c => pathFor(c.uri)).filter((f): f is string => !!f))

        if (files.size === 0) {
          return []
        }

        this.workspace.forget()
        this.readersByRoot.clear()
        this.deckOf = projectDeckOf()

        const out: Message[] = []

        for (const doc of this.documents.values()) {
          const touched = [...files].some(f => doc.closure.has(f) || doc.closure.has(canonical(f)))
          const config = [...files].some(f => /(?:^|[\\/])(?:role|deck)\.tree$/.test(f))

          if (touched || config) {
            doc.stale = true

            if (this.deferred()) {
              this.schedule(doc)
            } else {
              out.push(...this.run(doc, false))
            }
          }
        }

        return out
      }

      case 'textDocument/diagnostic': {
        const doc = this.settled(params, outbox)
        const previous = (params as { previousResultId?: string } | null)?.previousResultId

        if (!doc?.view) {
          return [respond(message, { kind: 'full', items: [] })]
        }

        const resultId = String(doc.resultId)

        return [
          respond(
            message,
            previous === resultId
              ? { kind: 'unchanged', resultId }
              : { kind: 'full', resultId, items: doc.view.diagnostics },
          ),
        ]
      }

      case 'textDocument/hover': {
        const doc = this.settled(params, outbox)
        const position = positionOf(params)
        const view = doc?.view

        if (!view) {
          return [respond(message, null)]
        }

        const at = view.map.inner(position)
        // prefer the definition under the cursor (its full signature) over a bare expression type: hovering a `call`
        // shows `greet(name: text) -> text`, not just the result type. Fall back to the inferred expression type.
        const named = symbolAt(view.index, at)
        const def = named ? this.definitionOf(view, named) : undefined
        const type = view.typed ? hoverAt(view.program, at) : undefined
        // the `#` lines above a top-level definition, as `term look` prints them (make/code/inspect.ts)
        const located = def && named && !named.scope && doc ? this.locate(doc, view, named) : undefined
        const value = hoverMarkdown(def, type, located ? this.docCommentAt(located) : undefined)

        return [
          respond(
            message,
            value ? { contents: { kind: 'markdown', value } } : null,
          ),
        ]
      }

      case 'textDocument/definition': {
        const doc = this.settled(params, outbox)
        const position = positionOf(params)
        const view = doc?.view

        if (!doc) {
          return [respond(message, null)]
        }

        // a path or a `find` first: their words are not references, and a path's last segment is often a word
        // something else declares
        const textual = this.textualDefinition(doc, position)

        if (textual !== undefined) {
          return [respond(message, textual)]
        }

        // a name the compiled program refers to, through its scope and its imports
        const named = view ? symbolAt(view.index, view.map.inner(position), true) : undefined
        const located = view && named ? this.locate(doc, view, named) : undefined

        // else the word itself: a type after `like`, a component, a rule in a mill definition, a name in a file
        // that did not compile. Last, the reference whose expression holds the cursor (on `call` of `call f`).
        const loose = view && !located ? symbolAt(view.index, view.map.inner(position)) : undefined

        return [
          respond(
            message,
            located ??
              this.wordDefinition(doc, position) ??
              (view && loose ? this.locate(doc, view, loose) : undefined) ??
              null,
          ),
        ]
      }

      case 'textDocument/documentLink': {
        // every path a document names, underlined, each opening the module the compiler would read. A path that
        // resolves to nothing has no link.
        const doc = this.documents.get(uriOf(params))

        if (!doc) {
          return [respond(message, [])]
        }

        const links: { range: LspRange; target: string; tooltip: string }[] = []

        for (const mention of pathMentions(doc.file, doc.text)) {
          const source = this.resolveModule(doc, mention.path)

          if (source && isFilePath(source.file)) {
            links.push({ range: toRange(mention.span), target: uriFor(source.file), tooltip: source.file })
          }
        }

        return [respond(message, links)]
      }

      case 'textDocument/references': {
        const doc = this.settled(params, outbox)
        const position = positionOf(params)
        const view = doc?.view

        if (!doc || !view) {
          return [respond(message, [])]
        }

        const named = symbolAt(view.index, view.map.inner(position))

        if (!named) {
          return [respond(message, [])]
        }

        const includeDeclaration =
          (params as { context?: { includeDeclaration?: boolean } } | null)?.context?.includeDeclaration ?? true

        const locations: { uri: string; range: LspRange }[] = []

        for (const [uri, spans] of this.occurrences(doc, view, named, false)) {
          for (const span of spans) {
            locations.push({ uri, range: toRange(span) })
          }
        }

        if (!includeDeclaration) {
          const declared = this.locate(doc, view, named)

          return [
            respond(
              message,
              locations.filter(
                l =>
                  !declared ||
                  l.uri !== declared.uri ||
                  l.range.start.line !== declared.range.start.line ||
                  l.range.start.character !== declared.range.start.character,
              ),
            ),
          ]
        }

        return [respond(message, locations)]
      }

      case 'textDocument/prepareRename': {
        const doc = this.settled(params, outbox)
        const position = positionOf(params)
        const view = doc?.view

        if (!doc || !view) {
          return [respond(message, null)]
        }

        const at = view.map.inner(position)
        const named = symbolAt(view.index, at, true)

        if (!named) {
          return [respond(message, null)]
        }

        const spans = occurrencesOf(view.index, named).map(s => outerSpan(view.map, s))
        const under = spans.find(
          s =>
            s.start.line === position.line &&
            s.start.column <= position.character &&
            s.end.column >= position.character,
        )

        return [
          respond(
            message,
            under ? { range: toRange(under), placeholder: writtenName(named.name) } : null,
          ),
        ]
      }

      case 'textDocument/rename': {
        const doc = this.settled(params, outbox)
        const position = positionOf(params)
        const newName = (params as { newName?: unknown } | null)?.newName
        const view = doc?.view

        if (typeof newName !== 'string' || !/^[A-Za-z][A-Za-z0-9-]*$/.test(newName)) {
          throw new ParamsError('newName must be a Term name (letters, digits and dashes, starting with a letter)')
        }

        if (!doc || !view) {
          return [respond(message, null)]
        }

        // not strict: a client that skips `prepareRename` may send the start of `call helper`, and every edit below
        // is a NAME span whichever way the symbol was found
        const named = symbolAt(view.index, view.map.inner(position))

        if (!named) {
          return [respond(message, null)]
        }

        const changes: Record<string, { range: LspRange; newText: string }[]> = {}

        for (const [uri, spans] of this.occurrences(doc, view, named, true)) {
          changes[uri] = spans.map(span => ({ range: toRange(span), newText: newName }))
        }

        return [respond(message, { changes })]
      }

      case 'textDocument/documentHighlight': {
        const doc = this.settled(params, outbox)
        const position = positionOf(params)
        const view = doc?.view

        if (!view) {
          return [respond(message, [])]
        }

        const named = symbolAt(view.index, view.map.inner(position))

        if (!named) {
          return [respond(message, [])]
        }

        const declared = named.scope
          ? named.scope.locals.find(l => l.name === named.name)?.at
          : view.index.definitions.get(named.name)?.at

        return [
          respond(
            message,
            occurrencesOf(view.index, named).map(span => ({
              range: toRange(outerSpan(view.map, span)),
              // 3 Write at the declaration, 2 Read at every use
              kind:
                declared &&
                declared.start.line === span.start.line &&
                declared.start.column === span.start.column
                  ? 3
                  : 2,
            })),
          ),
        ]
      }

      case 'textDocument/documentSymbol': {
        const doc = this.settled(params, outbox)
        const view = doc?.view

        if (!view) {
          return [respond(message, [])]
        }

        const symbols = [...view.index.definitions.values()]
          .filter(d => d.kind === 'function' || d.kind === 'type' || d.kind === 'trait')
          .map(d => {
            const range = outerRange(view.map, toRange(d.span))
            const name = d.at ? outerRange(view.map, toRange(d.at)) : range

            return {
              name: writtenName(d.name),
              detail: d.detail,
              kind: SYMBOL_KIND[d.kind],
              range,
              selectionRange: name,
            }
          })

        return [respond(message, symbols)]
      }

      case 'workspace/symbol': {
        const query = String((params as { query?: unknown } | null)?.query ?? '')
        const roots = this.roots()
        const found = this.workspace.symbols(roots, query)

        return [
          respond(
            message,
            found.map(s => ({
              name: s.name,
              kind: DEF_SYMBOL_KIND[s.kind] ?? 13,
              location: {
                uri: uriFor(s.file),
                range: {
                  start: { line: s.line, character: s.column },
                  end: { line: s.line, character: s.column + s.name.length },
                },
              },
            })),
          ),
        ]
      }

      case 'textDocument/foldingRange': {
        const doc = this.documents.get(uriOf(params))

        return [respond(message, doc ? foldingRanges(doc.text) : [])]
      }

      case 'textDocument/selectionRange': {
        const doc = this.documents.get(uriOf(params))
        const positions = (params as { positions?: LspPosition[] } | null)?.positions

        if (!Array.isArray(positions)) {
          throw new ParamsError('missing positions')
        }

        return [respond(message, doc ? positions.map(p => selectionRange(doc.text, p)) : [])]
      }

      case 'textDocument/completion':
        return [respond(message, this.complete(params, outbox))]

      case 'textDocument/signatureHelp': {
        const doc = this.settled(params, outbox)
        const position = positionOf(params)
        const view = doc?.view

        if (!view) {
          return [respond(message, null)]
        }

        const call = callAt(view.program, view.map.inner(position))
        const sig = call && view.index.signatures.get(call.name)

        if (!call || !sig) {
          return [respond(message, null)]
        }

        const label = `${writtenName(call.name)}(${sig.params
          .map(p => `${p.name}: ${p.type}`)
          .join(', ')}) -> ${sig.result}`

        return [
          respond(message, {
            signatures: [
              {
                label,
                parameters: sig.params.map(p => ({
                  label: `${p.name}: ${p.type}`,
                })),
              },
            ],
            activeSignature: 0,
            activeParameter: Math.min(
              call.activeParam,
              Math.max(0, sig.params.length - 1),
            ),
          }),
        ]
      }

      case 'textDocument/semanticTokens/full': {
        const doc = this.settled(params, outbox)
        const view = doc?.view

        if (!doc || !view) {
          return [respond(message, { data: [] })]
        }

        const { data } = semanticTokens(view.inner, view.index, view.map)
        const id = String(++this.tokenCounter)
        doc.tokens = { id, data }

        return [respond(message, { resultId: id, data })]
      }

      case 'textDocument/semanticTokens/full/delta': {
        const doc = this.settled(params, outbox)
        const view = doc?.view
        const previous = (params as { previousResultId?: string } | null)?.previousResultId

        if (!doc || !view) {
          return [respond(message, { data: [] })]
        }

        const { data } = semanticTokens(view.inner, view.index, view.map)
        const id = String(++this.tokenCounter)
        const before = doc.tokens
        doc.tokens = { id, data }

        if (!before || before.id !== previous) {
          return [respond(message, { resultId: id, data })]
        }

        return [respond(message, { resultId: id, edits: tokenEdits(before.data, data) })]
      }

      case 'textDocument/inlayHint': {
        const doc = this.settled(params, outbox)
        const view = doc?.view
        const range = (params as { range?: LspRange } | null)?.range

        if (!view || !range) {
          return [respond(message, [])]
        }

        const inner = {
          start: view.map.inner(range.start),
          end: view.map.inner(range.end),
        }

        const hints = inlayHints(view.program, view.inner, inner, {
          lean: view.lean,
          signatures: view.index.signatures,
        }).map(h => ({ ...h, position: view.map.outer(h.position, 'start') }))

        return [respond(message, hints)]
      }

      case 'textDocument/codeLens': {
        // a reference count above each top-level definition, from this document's index
        const doc = this.settled(params, outbox)
        const view = doc?.view

        if (!view) {
          return [respond(message, [])]
        }

        const lenses = [...view.index.definitions.values()]
          .filter(d => d.kind === 'function' || d.kind === 'type' || d.kind === 'trait')
          .map(d => {
            // occurrences include the definition itself, so subtract it
            const refs = Math.max(0, occurrencesOf(view.index, d.name).length - (d.at ? 1 : 0))

            return {
              range: outerRange(view.map, toRange(d.at ?? d.span)),
              command: {
                title: `${refs} reference${refs === 1 ? '' : 's'}`,
                command: '',
              },
            }
          })

        return [respond(message, lenses)]
      }

      case 'textDocument/codeAction':
        return [respond(message, this.codeActions(params, outbox))]

      case 'textDocument/implementation': {
        // go to the implementations of a trait (mask) or one of its methods: the instance targets that conform to it.
        const doc = this.settled(params, outbox)
        const position = positionOf(params)
        const view = doc?.view

        if (!doc || !view) {
          return [respond(message, null)]
        }

        const named = symbolAt(view.index, view.map.inner(position))

        if (!named) {
          return [respond(message, null)]
        }

        const locations: { uri: string; range: LspRange }[] = []

        for (const statement of view.program) {
          if (statement.form !== 'instance') {
            continue
          }

          // the cursor is on the trait name itself, or on a method the trait declares (the instance implements it)
          const onTrait = statement.mask === named.name
          const onMethod = statement.methods?.includes(named.name)

          if (!onTrait && !onMethod) {
            continue
          }

          const definition = view.index.definitions.get(statement.target)

          if (definition) {
            locations.push({
              uri: doc.uri,
              range: outerRange(view.map, toRange(definition.at ?? definition.span)),
            })
          }
        }

        return [respond(message, locations.length ? locations : null)]
      }

      case 'textDocument/prepareCallHierarchy': {
        const doc = this.settled(params, outbox)
        const position = positionOf(params)
        const view = doc?.view

        if (!doc || !view) {
          return [respond(message, null)]
        }

        const named = symbolAt(view.index, view.map.inner(position))

        if (!named || named.scope) {
          return [respond(message, null)]
        }

        const location = this.locate(doc, view, named)

        if (!location) {
          return [respond(message, null)]
        }

        return [
          respond(message, [
            {
              name: writtenName(named.name),
              kind: 12,
              uri: location.uri,
              range: location.range,
              selectionRange: location.range,
              data: { name: named.name, uri: doc.uri },
            },
          ]),
        ]
      }

      case 'callHierarchy/incomingCalls':
        return [respond(message, this.incomingCalls(params))]

      case 'callHierarchy/outgoingCalls':
        return [respond(message, this.outgoingCalls(params))]

      default:
        // an unknown request still needs a response; an unknown notification is ignored
        return message.id !== undefined && message.id !== null
          ? [{ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unhandled method ${message.method}` } }]
          : []
    }
  }

  // ---- navigation ----

  // a definition for hover: a parameter or local of the enclosing task, else a top-level one of this file, else an
  // imported task's signature (span-free, from the closure summary)
  private definitionOf(
    view: View,
    named: Named,
  ): { name: string; kind: SymbolKind; detail: string } | undefined {
    if (named.scope) {
      return named.scope.locals.find(l => l.name === named.name)
    }

    const own = view.index.definitions.get(named.name)

    if (own) {
      return own
    }

    const sig = view.summary.signatures.get(named.name)

    return sig
      ? {
          name: named.name,
          kind: 'function',
          detail: `(${sig.params.map(p => `${p.name}: ${p.type}`).join(', ')}) -> ${sig.result}`,
        }
      : undefined
  }

  // where a name is defined: a local in its task, a top-level definition in this file, or the module a `load`
  // brought it from (its file, at the name)
  private locate(doc: Doc, view: View, named: Named): { uri: string; range: LspRange } | undefined {
    if (named.scope) {
      const local = named.scope.locals.find(l => l.name === named.name)

      return local?.at ? { uri: doc.uri, range: outerRange(view.map, toRange(local.at)) } : undefined
    }

    const own = view.index.definitions.get(named.name)

    if (own) {
      return { uri: doc.uri, range: outerRange(view.map, toRange(own.at ?? own.span)) }
    }

    const definer = this.definer(doc, named.name)

    return definer
      ? {
          uri: uriFor(definer.file),
          range: {
            start: { line: definer.line, character: definer.column },
            end: { line: definer.line, character: definer.column + writtenName(named.name).length },
          },
        }
      : undefined
  }

  // the doc comment of the top-level definition on a located line: the `#` lines the parser keeps on its group (CST
  // trivia), the `#` and one space taken off each, joined as `term look` joins them. The open document's text when
  // the file is open, else the file on disk
  private docCommentAt(located: { uri: string; range: LspRange }): string | undefined {
    const open = this.documents.get(located.uri)
    const file = pathFor(located.uri)
    let text = open?.text

    if (text === undefined && file !== undefined) {
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        return undefined
      }
    }

    if (text === undefined) {
      return undefined
    }

    const group = parseTolerant({ file: file ?? located.uri, text }).tree.nodes.find(
      node => spanOfNode(node)?.start.line === located.range.start.line,
    )
    const note = (group?.comments ?? [])
      .map(comment => comment.text.replace(/^#\s?/, '').trim())
      .filter(Boolean)
      .join(' ')

    return note || undefined
  }

  // a file that is not open, as the document `resolveModule` asks from
  private fileDoc(file: string): Doc {
    return {
      uri: uriFor(file),
      file,
      path: isFilePath(file) ? file : undefined,
      text: '',
      version: 0,
      revision: 0,
      analyzed: -1,
      stale: false,
      closure: new Set(),
      direct: new Map(),
      resultId: 0,
    }
  }

  // THE ONE PLACE A PATH BECOMES A FILE, for every editor feature: definition, document links, `find` targets,
  // a manifest's `code` and `link`. It asks the resolver the compiler is given for this document (the package's
  // `projectResolver`, `{platform}` filled for node, with open buffers in place of their files), so a path the
  // editor opens is the module the build reads. Nothing resolves anywhere else in the server: the package path rule
  // (code root first, then package root, and a bare `@scope/name` to its entry) is `resolvePackagePath` in
  // make/code/resolve.ts, which that resolver calls. Undefined when the path names nothing, never a guess.
  private resolveModule(doc: Doc, path: string): Source | undefined {
    const resolve = this.resolverFor({ ...doc, closure: new Set(), direct: new Map() }, this.readersFor(doc.file).root)

    if (!resolve) {
      return undefined
    }

    try {
      return resolve(path, doc.file)
    } catch {
      return undefined
    }
  }

  // the module a document loads that defines a name at top level, with the name's position in it
  private definer(
    doc: Doc,
    name: string,
  ): { file: string; line: number; column: number } | undefined {
    const written = writtenName(name)

    for (const mention of pathMentions(doc.file, doc.text)) {
      if (mention.head === 'link') {
        continue
      }

      const source = this.resolveModule(doc, mention.path)
      const def = source ? declarationsOf(source.file, source.text).find(d => d.name === written) : undefined

      if (source && def) {
        return { file: source.file, line: def.span.start.line, column: def.span.start.column }
      }
    }

    return undefined
  }

  // Cmd+click on what is not a reference in the compiled program: a path, a `find`, a type after `like`, a rule in
  // a mill definition. Undefined means this position names no file and no declaration; `null` means it names a
  // path or a `find` that resolves to nothing, which answers null rather than falling through to the word under it.
  private textualDefinition(
    doc: Doc,
    position: LspPosition,
  ): { uri: string; range: LspRange } | null | undefined {
    const mentions = pathMentions(doc.file, doc.text)
    const at = mentionAt(mentions, position.line, position.character)
    const top = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }

    if (at && at.find === undefined) {
      const source = this.resolveModule(doc, at.mention.path)

      return source && isFilePath(source.file) ? { uri: uriFor(source.file), range: top } : null
    }

    if (at?.find) {
      const source = this.resolveModule(doc, at.mention.path)
      const def = source ? declarationsOf(source.file, source.text).find(d => d.name === at.find) : undefined

      return source && def && isFilePath(source.file)
        ? { uri: uriFor(source.file), range: toRange(def.span) }
        : null
    }

    return undefined
  }

  // the word under the cursor, declared in this file or in a module it loads
  private wordDefinition(doc: Doc, position: LspPosition): { uri: string; range: LspRange } | undefined {
    const word = wordAt(doc.text, position.line, position.character)

    // a keyword is the language's, not a declaration's, even where a module happens to declare the same word
    if (!word || KEYWORDS.includes(word) || ['back', 'true', 'false', 'void'].includes(word)) {
      return undefined
    }

    const own = declarationsOf(doc.file, doc.text).find(d => d.name === word)

    if (own) {
      return { uri: doc.uri, range: toRange(own.span) }
    }

    const found = this.definer(doc, word)

    return found && isFilePath(found.file)
      ? {
          uri: uriFor(found.file),
          range: {
            start: { line: found.line, character: found.column },
            end: { line: found.line, character: found.column + word.length },
          },
        }
      : undefined
  }

  // the packages a workspace question searches: every open document's
  private roots(extra?: string): string[] {
    const roots = new Set<string>()

    for (const doc of this.documents.values()) {
      const root = doc.path ? findProjectRoot(doc.file) : undefined

      if (root) {
        roots.add(root)
      }
    }

    const more = extra ? findProjectRoot(extra) : undefined

    if (more) {
      roots.add(more)
    }

    return [...roots]
  }

  // Every place a name is written, by document uri. A parameter or local is its task's alone. A top-level name is
  // its defining file's occurrences plus, across the packages, every file that imports it from that file. For a
  // rename, an importer that aliases the import (`find x, name y`) has only its `find` token edited.
  private occurrences(doc: Doc, view: View, named: Named, rename: boolean): Map<string, Span[]> {
    const out = new Map<string, Span[]>()
    const add = (uri: string, spans: Span[]): void => {
      if (spans.length === 0) {
        return
      }

      const list = out.get(uri) ?? []
      const seen = new Set(list.map(s => `${s.start.line}:${s.start.column}`))

      for (const span of spans) {
        const key = `${span.start.line}:${span.start.column}`

        if (!seen.has(key)) {
          seen.add(key)
          list.push(span)
        }
      }

      out.set(uri, list)
    }

    const here = occurrencesOf(view.index, named).map(s => outerSpan(view.map, s))

    if (named.scope) {
      add(doc.uri, here)

      return out
    }

    const name = named.name
    const ownDefinition = view.index.definitions.has(name)
    const definer = ownDefinition ? { file: doc.file } : this.definer(doc, name)

    if (!definer || !doc.path) {
      // a name defined nowhere this server can see, or a document with no file: this document alone
      add(doc.uri, here)

      return out
    }

    // the defining file's own occurrences: this view when it is this document, else its index
    if (ownDefinition) {
      add(doc.uri, here)
    } else {
      const text = this.workspace.read(definer.file)
      const indexed = text !== undefined ? this.workspace.indexOf(definer.file, text) : undefined

      if (indexed) {
        add(
          uriFor(definer.file),
          occurrencesOf(indexed.index, writtenName(name)).map(s => outerSpan(indexed.map, s)),
        )
      }
    }

    for (const importer of this.workspace.importers(this.roots(definer.file), writtenName(name), definer.file)) {
      const uri = this.byFile.get(importer.file)?.uri ?? uriFor(importer.file)

      add(uri, importer.finds)

      if (!rename || !importer.aliased) {
        add(uri, importer.spans)
      }

      // an alias's uses refer to the definition, but a rename leaves the alias alone
      if (!rename) {
        add(uri, importer.aliasSpans)
      }
    }

    // this document, when it imports the name rather than defines it, is one of the importers above; when the
    // workspace could not see it (outside every package), its own occurrences still count
    if (!ownDefinition && !out.has(doc.uri)) {
      add(doc.uri, here)
    }

    for (const [uri, spans] of out) {
      out.set(
        uri,
        spans.sort((a, b) => a.start.line - b.start.line || a.start.column - b.start.column),
      )
    }

    return out
  }

  private incomingCalls(params: unknown): unknown[] {
    const item = need((params as { item?: { name?: string; data?: { name?: string; uri?: string } } } | null)?.item, 'item')
    const uri = item.data?.uri
    const name = item.data?.name ?? item.name
    const doc = uri ? this.documents.get(uri) : undefined

    if (!doc?.view || !name) {
      return []
    }

    const named: Named = { name }
    const calls = new Map<string, { item: unknown; fromRanges: LspRange[] }>()

    // each place the name is written, grouped by the task that holds it
    for (const [where, spans] of this.occurrences(doc, doc.view, named, false)) {
      const file = pathFor(where)
      const open = this.documents.get(where)
      const index =
        open?.view
          ? { index: open.view.index, map: open.view.map }
          : file
            ? (() => {
                const text = this.workspace.read(canonical(file))

                return text !== undefined ? this.workspace.indexOf(canonical(file), text) : undefined
              })()
            : undefined

      if (!index) {
        continue
      }

      for (const span of spans) {
        const caller = index.index.scopes.find(s => {
          const start = outerSpan(index.map, s.span)

          return (
            (start.start.line < span.start.line ||
              (start.start.line === span.start.line && start.start.column <= span.start.column)) &&
            (start.end.line > span.start.line ||
              (start.end.line === span.start.line && start.end.column >= span.start.column))
          )
        })

        // the definition itself is not a call of it
        if (!caller || (caller.name === name && where === uri)) {
          const def = index.index.definitions.get(name)

          if (def?.at && outerSpan(index.map, def.at).start.line === span.start.line) {
            continue
          }

          if (!caller) {
            continue
          }
        }

        const def = index.index.definitions.get(caller.name)
        const range = toRange(outerSpan(index.map, def?.at ?? caller.span))
        const key = `${where}#${caller.name}`
        const entry = calls.get(key) ?? {
          item: {
            name: writtenName(caller.name),
            kind: 12,
            uri: where,
            range: toRange(outerSpan(index.map, caller.span)),
            selectionRange: range,
            data: { name: caller.name, uri: where },
          },
          fromRanges: [],
        }

        entry.fromRanges.push(toRange(span))
        calls.set(key, entry)
      }
    }

    return [...calls.values()].map(c => ({ from: c.item, fromRanges: c.fromRanges }))
  }

  private outgoingCalls(params: unknown): unknown[] {
    const item = need((params as { item?: { name?: string; data?: { name?: string; uri?: string } } } | null)?.item, 'item')
    const uri = item.data?.uri
    const name = item.data?.name ?? item.name
    const doc = uri ? this.documents.get(uri) : undefined
    const view = doc?.view

    if (!doc || !view || !name) {
      return []
    }

    const fn = view.program.find(
      (s): s is Extract<Statement, { form: 'function' }> => s.form === 'function' && s.name === name,
    )

    if (!fn) {
      return []
    }

    const calls = new Map<string, { to: unknown; fromRanges: LspRange[] }>()
    const index = view.index

    forEachCall([fn], call => {
      if (call.callee.form !== 'variable') {
        return
      }

      const callee = call.callee.name

      // a call of a parameter (a task passed in) is not a call of a definition
      if (index.scopes.find(s => s.name === name)?.locals.some(l => l.name === callee)) {
        return
      }

      const ref = index.references.find(
        r =>
          r.name === callee &&
          r.span.start.line === call.callee.span.start.line &&
          r.span.start.column === call.callee.span.start.column,
      )

      const location = this.locate(doc, view, { name: callee })

      if (!location) {
        return
      }

      const entry = calls.get(callee) ?? {
        to: {
          name: writtenName(callee),
          kind: 12,
          uri: location.uri,
          range: location.range,
          selectionRange: location.range,
          data: { name: callee, uri: location.uri },
        },
        fromRanges: [],
      }

      entry.fromRanges.push(outerRange(view.map, toRange(ref?.at ?? call.callee.span)))
      calls.set(callee, entry)
    })

    return [...calls.values()]
  }

  // ---- completion ----

  private complete(params: unknown, outbox: Message[]): { isIncomplete: boolean; items: Item[] } {
    const doc = this.settled(params, outbox)
    const position = positionOf(params)

    if (!doc) {
      return { isIncomplete: false, items: [] }
    }

    const view = doc.view
    const lean = view?.lean ?? false
    const inner = view ? view.map.inner(position) : position
    const index = view?.index
    const scope = index ? scopeAt(index, inner) : []
    const line = doc.text.split('\n')[position.line]?.slice(0, position.character) ?? ''

    // import-path completion: `load @scope/pkg/...` offers the modules available under that prefix
    const loadPath = /^\s*(?:load|bear)\s+(@\S*)$/.exec(line)?.[1]

    if (loadPath !== undefined && doc.path) {
      const root = findProjectRoot(doc.path)
      const items = root
        ? moduleCompletions(root, loadPath).map(m => ({
            label: m.name,
            kind: m.isDir ? KIND_FOLDER : KIND_MODULE,
          }))
        : []

      if (items.length) {
        return { isIncomplete: false, items }
      }
    }

    // export completion: `find <partial>` inside a `load` block offers that module's top-level definitions
    if (/^\s*find\s+[A-Za-z0-9-]*$/.test(line)) {
      const importPath = enclosingLoad(doc.text, position.line)
      const source = importPath ? this.resolveModule(doc, importPath) : undefined

      const items = (source ? scanDefs(source.text) : []).map(d => ({
        label: d.name,
        kind: EXPORT_KIND[d.kind] ?? KIND_MODULE,
        detail: d.kind,
      }))

      if (items.length) {
        return { isIncomplete: false, items }
      }
    }

    // member completion: after `<receiver>/`, resolve the receiver's type and offer that type's fields + methods
    if (view) {
      const receiver = memberReceiver(line)
      const typeName = receiver
        ? leadingName(scope.find(d => d.name === receiver)?.detail ?? '')
        : undefined

      if (typeName) {
        const fs = view.summary.fields.get(typeName) ?? []
        const ms = view.summary.methods.get(typeName) ?? []

        if (fs.length || ms.length) {
          return {
            isIncomplete: false,
            items: [
              ...fs.map(f => ({
                label: f.name,
                kind: KIND_FIELD,
                detail: f.type,
                sortText: `0${f.name}`,
              })),
              ...ms.map(m => ({
                label: m.name,
                kind: KIND_METHOD,
                detail: m.detail,
                sortText: `1${m.name}`,
              })),
            ],
          }
        }
      }
    }

    // argument-type ranking: inside a call, the type the current argument expects. A scope value of that exact type
    // ranks to the very top.
    const call = view ? callAt(view.program, inner) : undefined
    const sig = call ? index?.signatures.get(call.name) : undefined
    const expected = sig?.params[call!.activeParam]?.type

    // default: in-scope symbols first (a type match floats up), then imported callables (from the closure summary,
    // which the document-scoped index does not carry), then keyword snippets
    const seen = new Set<string>()
    const fromScope: Item[] = []

    for (const d of scope) {
      const label = writtenName(d.name)

      if (seen.has(label)) {
        continue
      }

      seen.add(label)
      fromScope.push({
        label,
        kind: COMPLETION_KIND[d.kind],
        detail: d.detail,
        // a value matching the expected argument type sorts to `0`, ahead of the rest of the scope at `1`
        sortText: expected && d.detail === expected ? `0${label}` : `1${label}`,
      })
    }

    const fromImports: Item[] = []

    for (const d of view?.summary.topLevel ?? []) {
      const label = writtenName(d.name)

      if (seen.has(label)) {
        continue
      }

      seen.add(label)
      fromImports.push({ label, kind: d.kind, detail: d.detail, sortText: `2${label}` })
    }

    return {
      isIncomplete: false,
      items: [...fromScope, ...fromImports, ...keywordItems(lean)],
    }
  }

  // ---- code actions ----

  private codeActions(params: unknown, outbox: Message[]): unknown[] {
    const doc = this.settled(params, outbox)
    const view = doc?.view

    if (!doc || !view) {
      return []
    }

    const request = params as {
      range?: LspRange
      context?: { diagnostics?: { range: LspRange; code?: unknown; data?: { name?: string } }[]; only?: string[] }
    } | null

    const range = request?.range
    const actions: unknown[] = []
    const seen = new Set<string>()
    const root = doc.path ? findProjectRoot(doc.path) : undefined

    for (const diag of request?.context?.diagnostics ?? []) {
      // the old spelling of privacy: rewrite it to the one the language reads now
      if (diag.data?.name === 'note-private') {
        actions.push({
          title: 'Write `mark private` (the current spelling)',
          kind: 'quickfix',
          isPreferred: true,
          edit: { changes: { [doc.uri]: [{ range: diag.range, newText: 'mark private' }] } },
        })
        continue
      }

      // the old spelling of metadata, `note <word>`: the diagnostic's span starts at the `note` word, so the fix
      // replaces those four characters with `mark` and leaves the word after it as written
      if (diag.data?.name === 'note-metadata') {
        const start = diag.range.start

        actions.push({
          title: 'Write `mark` (metadata is `mark`, `note` is the old spelling)',
          kind: 'quickfix',
          isPreferred: true,
          edit: {
            changes: {
              [doc.uri]: [
                {
                  range: { start, end: { line: start.line, character: start.character + 4 } },
                  newText: 'mark',
                },
              ],
            },
          },
        })
        continue
      }

      // auto-import: an "unknown name" a linked package exports is offered as a `load` / `find`
      if (!root) {
        continue
      }

      const name = nameInRange(doc.text, diag.range)

      if (!name || seen.has(name)) {
        continue
      }

      seen.add(name)

      let found: ReturnType<typeof findModuleExporting>

      try {
        found = findModuleExporting(root, name)
      } catch {
        found = undefined
      }

      if (!found) {
        continue
      }

      actions.push({
        title: `Import ${name} from ${found.importPath}`,
        kind: 'quickfix',
        edit: {
          changes: {
            [doc.uri]: [importEdit(doc.text, found.importPath, name)],
          },
        },
      })
    }

    // lint fixes: the findings of the last analysis (the same ones shown as diagnostics), each fixable one in range
    // as a quick fix, and every fixable one at once as `source.fixAll`
    const overlaps = (span: Span): boolean =>
      !range ||
      !(
        span.end.line < range.start.line ||
        (span.end.line === range.start.line && span.end.column < range.start.character) ||
        span.start.line > range.end.line ||
        (span.start.line === range.end.line && span.start.column > range.end.character)
      )

    const fixable = view.findings.filter(finding => finding.fix)

    for (const finding of fixable.filter(f => overlaps(f.span))) {
      actions.push({
        title: `${finding.message} (${finding.code})`,
        kind: 'quickfix',
        diagnostics: [
          view.diagnostics.find(
            d =>
              d.code === finding.code &&
              d.range.start.line === finding.span.start.line &&
              d.range.start.character === finding.span.start.column,
          ),
        ].filter(Boolean),
        edit: {
          changes: {
            [doc.uri]: [{ range: toRange(finding.fix!.span), newText: finding.fix!.text }],
          },
        },
      })
    }

    if (fixable.length > 1) {
      actions.push({
        title: `Fix all ${fixable.length} lint findings`,
        kind: 'source.fixAll',
        edit: {
          changes: {
            [doc.uri]: fixable.map(finding => ({
              range: toRange(finding.fix!.span),
              newText: finding.fix!.text,
            })),
          },
        },
      })
    }

    const only = request?.context?.only

    return only?.length
      ? actions.filter(a => only.some(kind => String((a as { kind: string }).kind).startsWith(kind)))
      : actions
  }
}

// the edits between two semantic token arrays: one replacement from the first differing integer to the last
function tokenEdits(before: number[], after: number[]): { start: number; deleteCount: number; data: number[] }[] {
  let start = 0

  while (start < before.length && start < after.length && before[start] === after[start]) {
    start++
  }

  if (start === before.length && start === after.length) {
    return []
  }

  let endBefore = before.length
  let endAfter = after.length

  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--
    endAfter--
  }

  return [{ start, deleteCount: endBefore - start, data: after.slice(start, endAfter) }]
}

function respond(message: Message, result: unknown): Message {
  return { jsonrpc: '2.0', id: message.id, result }
}

function notify(method: string, params: unknown): Message {
  return { jsonrpc: '2.0', method, params }
}

function logMessage(text: string): Message {
  return notify('window/logMessage', { type: 1, message: `term flow: ${text}` })
}
