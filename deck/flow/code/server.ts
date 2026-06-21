// The Language Server itself: a pure message dispatcher over the LSP protocol. `dispatch` takes one incoming message
// and returns the outgoing messages (responses and notifications) to write back, so it is fully testable without any
// streams. It keeps a document store, the last good typed program per file, and a symbol index built from it, and
// recompiles on every edit (the incremental cache makes an unchanged module a hit). Navigation (definition,
// references, rename, symbols, completion, signature help) are queries over the index. The node entry point
// (main.ts) pumps stdin/stdout into it.

import type { Message } from '@cluesurf/flow/code/protocol'
import { hoverAt, toRange, toLspDiagnostic } from '@cluesurf/flow/code/analyze'
import type {
  LspDiagnostic,
  LspPosition,
} from '@cluesurf/flow/code/analyze'
import { IncrementalAnalyzer } from '@cluesurf/make/code/compile/analyzer'
import {
  editorResolver,
  findModuleExporting,
  findProjectRoot,
  moduleCompletions,
  moduleExports,
  scanDefs,
} from '@cluesurf/make/code/resolve'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  buildIndex,
  signaturesOf,
  referenceAt,
  occurrencesOf,
  scopeAt,
  callAt,
} from '@cluesurf/flow/code/symbols'
import type {
  SymbolIndex,
  SymbolKind,
} from '@cluesurf/flow/code/symbols'
import type { Resolver } from '@cluesurf/make/code/compile/load'
import type {
  Program,
  Statement,
} from '@cluesurf/make/code/compile/node'
import { showType } from '@cluesurf/make/code/compile/node'

type TextDocumentParams = {
  textDocument: { uri: string; text?: string }
}
type ChangeParams = {
  textDocument: { uri: string }
  contentChanges: { text: string }[]
}
type PositionParams = {
  textDocument: { uri: string }
  position: LspPosition
}
type RenameParams = PositionParams & { newName: string }

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

// the keywords offered in completion (the four-letter Seed vocabulary), each a plain keyword item
const KEYWORDS = [
  'task',
  'take',
  'send',
  'back',
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
  'fork',
  'hook',
  'walk',
  'load',
  'find',
  'mark',
  'text',
  'wave',
  'like',
  'note',
  'hold',
  'dock',
  'mask',
  'wear',
  'suit',
]

// the hover popover as markdown. A definition under the cursor renders its full signature (a call shows
// `greet(name: text) -> text`, a form / mask its head + members); any other expression renders its inferred type. The
// `seed` fence lets the editor syntax-color the popover.
function hoverMarkdown(
  def: { name: string; kind: SymbolKind; detail: string } | undefined,
  type: string | undefined,
): string | undefined {
  if (def) {
    const value =
      def.kind === 'local' || def.kind === 'parameter'
        ? `${def.name}: ${def.detail}`
        : `${def.name}${def.detail}`
    return '```seed\n' + value + '\n```'
  }
  if (type) {
    return '```seed\n' + type + '\n```'
  }
  return undefined
}

// the resolver for an opened document, built from its own file path. A non-`file:` uri has no project on disk, so it
// resolves nothing (the document is still type-checked in isolation).
function resolverFor(uri: string): Resolver | undefined {
  if (!uri.startsWith('file:')) {
    return undefined
  }

  try {
    return editorResolver(fileURLToPath(uri))
  } catch {
    return undefined
  }
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

// every `load @scope/pkg/...` import path declared in a document (top-level, column 0)
function loadedModules(text: string): string[] {
  const out: string[] = []

  for (const line of text.split('\n')) {
    const match = /^load\s+(@\S+)/.exec(line)

    if (match) {
      out.push(match[1]!)
    }
  }

  return out
}

// the `load @scope/pkg/...` whose block contains the given line (a `find` is indented under its `load`), or undefined
function enclosingLoad(text: string, lineNumber: number): string | undefined {
  const lines = text.split('\n')

  for (let i = lineNumber - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    const match = /^load\s+(@\S+)/.exec(line)

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
function nameInRange(
  text: string,
  range: { start: { line: number; character: number }; end: { line: number; character: number } },
): string | undefined {
  const line = text.split('\n')[range.start.line] ?? ''
  const slice = line.slice(range.start.character, range.end.character)
  return /^[a-z][A-Za-z0-9-]*/.exec(slice.trim())?.[0]
}

// the edit that imports `name` from `importPath`: a `find` under an existing `load` of that module, else a new load
// block prepended to the file
function importEdit(
  text: string,
  importPath: string,
  name: string,
): { range: unknown; newText: string } {
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

// inlay hints for inferred let-binding types: a `save x` / `host x` with no `, like` annotation shows `: <type>` after
// the name. Recurses into every body so nested bindings are covered; only this document's statements are passed in.
type InlayHint = {
  position: { line: number; character: number }
  label: string
  kind: number
  paddingLeft: boolean
}
function inlayHints(
  program: Program,
  text: string,
  range: { start: { line: number }; end: { line: number } },
): InlayHint[] {
  const lines = text.split('\n')
  const hints: InlayHint[] = []

  const visitLet = (
    node: Extract<Statement, { form: 'let' }>,
  ): void => {
    const line = node.span.start.line

    if (line < range.start.line || line > range.end.line) {
      return
    }

    const src = lines[line] ?? ''

    // an explicitly annotated binding (`save x, like number`) needs no hint
    if (/^\s*(?:save|host)\s+[a-z][A-Za-z0-9-]*\s*,\s*like\b/.test(src)) {
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
        case 'if':
          node.branches.forEach(b => walk(b.body))
          if (node.otherwise) walk(node.otherwise)
          break
        case 'match':
          node.cases.forEach(c => walk(c.body))
          if (node.otherwise) walk(node.otherwise)
          break
        default:
          break
      }
    }
  }

  walk(program)
  return hints
}

// the LSP range covering a definition's name, from a `scanDefs` hit
function defRange(
  def: { line: number; column: number },
  name: string,
): {
  start: { line: number; character: number }
  end: { line: number; character: number }
} {
  return {
    start: { line: def.line, character: def.column },
    end: { line: def.line, character: def.column + name.length },
  }
}

// LSP CompletionItemKind for an imported definition
const KIND_MODULE = 9
const KIND_FOLDER = 19
const EXPORT_KIND: Record<string, number> = {
  task: 3, // Function
  form: 22, // Struct
  mask: 8, // Interface
  bind: 3,
}

// LSP CompletionItemKind values used here
const KIND_METHOD = 2
const KIND_FIELD = 5
const KIND_KEYWORD = 14

// statement-starting keywords scaffold their construct when accepted (LSP snippet syntax, insertTextFormat 2)
const KEYWORD_SNIPPETS: Record<string, string> = {
  task: 'task ${1:name}\n  take ${2:arg}, like ${3:type}\n  like ${4:type}\n  send back\n    $0',
  form: 'form ${1:name}\n  link ${2:field}, like ${3:type}',
  mask: 'mask ${1:name}\n  task ${2:method}\n    take self\n    like ${3:type}',
  fork: 'fork test\n  hook test\n    $1\n  hook hold\n    $0',
  walk: 'walk list, read ${1:items}\n  hook next\n  take ${2:item}, name ${2:item}\n    $0',
}

function keywordItems(): Array<Record<string, unknown>> {
  return KEYWORDS.map(label => {
    const snippet = KEYWORD_SNIPPETS[label]
    // keywords sort last (prefix `3`), after scope symbols and imported names
    return snippet
      ? {
          label,
          kind: KIND_KEYWORD,
          insertText: snippet,
          insertTextFormat: 2,
          sortText: `3${label}`,
        }
      : { label, kind: KIND_KEYWORD, sortText: `3${label}` }
  })
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

// the top-level, bare-callable definitions of a (merged) program: functions, forms, masks. Used to offer imported
// names in completion, since the document-scoped index only knows this file's own definitions.
function mergedTopLevel(
  program: Program,
): Array<{ name: string; kind: number; detail: string }> {
  const out: Array<{ name: string; kind: number; detail: string }> = []
  for (const statement of program) {
    if (statement.form === 'function' && !statement.method) {
      out.push({
        name: statement.name,
        kind: 3, // Function
        detail: signatureOf(statement),
      })
    } else if (statement.form === 'record-type') {
      out.push({
        name: statement.name,
        kind: statement.variants.length ? 13 : 22, // Enum : Struct
        detail: 'form',
      })
    } else if (statement.form === 'mask') {
      out.push({ name: statement.name, kind: 8, detail: 'mask' }) // Interface
    }
  }
  return out
}

// from the typed program: each record's fields and each form's methods, for member completion after `<receiver>/`
function memberMaps(program: Program): {
  fields: Map<string, Array<{ name: string; type: string }>>
  methods: Map<string, Array<{ name: string; detail: string }>>
} {
  const fields = new Map<string, Array<{ name: string; type: string }>>()
  const methods = new Map<
    string,
    Array<{ name: string; detail: string }>
  >()
  for (const statement of program) {
    if (statement.form === 'record-type') {
      fields.set(
        statement.name,
        statement.fields.map(f => ({
          name: f.name,
          type: showType(f.type),
        })),
      )
    } else if (statement.form === 'function' && statement.method) {
      const list = methods.get(statement.method.form) ?? []
      list.push({
        name: statement.method.name,
        detail: signatureOf(statement),
      })
      methods.set(statement.method.form, list)
    }
  }
  return { fields, methods }
}

export class LanguageServer {
  private readonly documents = new Map<string, string>()
  private readonly programs = new Map<string, Program>()
  // the document's own typed statements (not the merged graph), for features that read this file's nodes by position:
  // inlay hints place themselves on this file's let bindings, not an imported module's
  private readonly documentPrograms = new Map<string, Program>()
  private readonly indexes = new Map<string, SymbolIndex>()
  // one incremental analyzer per document: an edit re-checks only the definitions that changed (the firewall), so
  // diagnostics on keystroke are near-instant. See code/incremental.ts.
  private readonly analyzers = new Map<string, IncrementalAnalyzer>()
  private shuttingDown = false

  constructor(private readonly resolve?: Resolver) {}

  private analyzerFor(uri: string): IncrementalAnalyzer {
    let analyzer = this.analyzers.get(uri)

    if (!analyzer) {
      // an explicit resolver (tests) wins; otherwise build one from the document's own project root, so `@cluesurf/*`
      // and stdlib imports resolve exactly as a build would. A non-file uri or a file outside any project falls back
      // to the bundled stdlib only.
      const resolve = this.resolve ?? resolverFor(uri)
      analyzer = new IncrementalAnalyzer(resolve)
      this.analyzers.set(uri, analyzer)
    }

    return analyzer
  }

  async dispatch(message: Message): Promise<Message[]> {
    switch (message.method) {
      case 'initialize':
        return [
          respond(message, {
            capabilities: {
              textDocumentSync: 1,
              hoverProvider: true,
              definitionProvider: true,
              referencesProvider: true,
              renameProvider: true,
              documentSymbolProvider: true,
              completionProvider: { triggerCharacters: [' ', '/'] },
              signatureHelpProvider: { triggerCharacters: [' '] },
              codeActionProvider: true,
              codeLensProvider: { resolveProvider: false },
              inlayHintProvider: true,
            },
          }),
        ]
      case 'initialized':
        return []
      case 'shutdown':
        this.shuttingDown = true

        return [respond(message, null)]
      case 'exit':
        return []

      case 'textDocument/didOpen': {
        const params = message.params as TextDocumentParams

        return [
          await this.refresh(
            params.textDocument.uri,
            params.textDocument.text ?? '',
          ),
        ]
      }

      case 'textDocument/didChange': {
        const params = message.params as ChangeParams

        return [
          await this.refresh(
            params.textDocument.uri,
            params.contentChanges[params.contentChanges.length - 1]
              ?.text ?? '',
          ),
        ]
      }

      case 'textDocument/didClose': {
        const params = message.params as TextDocumentParams
        this.documents.delete(params.textDocument.uri)
        this.programs.delete(params.textDocument.uri)
        this.documentPrograms.delete(params.textDocument.uri)
        this.indexes.delete(params.textDocument.uri)

        return [
          notify('textDocument/publishDiagnostics', {
            uri: params.textDocument.uri,
            diagnostics: [],
          }),
        ]
      }

      case 'textDocument/hover': {
        const params = message.params as PositionParams
        const program = this.programs.get(params.textDocument.uri)
        const index = this.indexes.get(params.textDocument.uri)
        // prefer the definition under the cursor (its full signature) over a bare expression type: hovering a `call`
        // shows `greet(name: text) -> text`, not just the result type. Fall back to the inferred expression type.
        const ref = index
          ? referenceAt(index, params.position)
          : undefined
        const def = ref ? index!.definitions.get(ref.name) : undefined
        const type = program
          ? hoverAt(program, params.position)
          : undefined
        const value = hoverMarkdown(def, type)

        return [
          respond(
            message,
            value
              ? { contents: { kind: 'markdown', value } }
              : null,
          ),
        ]
      }

      case 'textDocument/definition': {
        const params = message.params as PositionParams
        const uri = params.textDocument.uri
        const index = this.indexes.get(uri)
        const ref = index && referenceAt(index, params.position)
        const text = this.documents.get(uri)

        if (!ref) {
          return [respond(message, null)]
        }

        // 1. a top-level definition (task / form / mask) in THIS document. Scan the document text directly rather than
        // the symbol index: the index is built from the whole merged program, so an imported definition of the same
        // name carries a span from its own file, not this one.
        const here = text
          ? scanDefs(text).find(d => d.name === ref.name)
          : undefined

        if (here) {
          return [respond(message, { uri, range: defRange(here, ref.name) })]
        }

        // 2. cross-file: the name may be imported. Search each `load`ed module for a top-level definition (task / form /
        // mask alike) and jump to it in that module's own file.
        const resolve = resolverFor(uri)

        if (text && resolve) {
          for (const importPath of loadedModules(text)) {
            const exp = moduleExports(importPath, resolve)
            const target = exp?.defs.find(d => d.name === ref.name)

            if (exp && target) {
              return [
                respond(message, {
                  uri: pathToFileURL(exp.file).href,
                  range: defRange(target, ref.name),
                }),
              ]
            }
          }
        }

        // 3. a local (parameter / let) introduced in this document: its index span is document-relative
        const local = index?.definitions.get(ref.name)

        return [
          respond(
            message,
            local ? { uri, range: toRange(local.span) } : null,
          ),
        ]
      }

      case 'textDocument/references': {
        const params = message.params as PositionParams
        const index = this.indexes.get(params.textDocument.uri)
        const ref = index && referenceAt(index, params.position)
        const spans = ref ? occurrencesOf(index, ref.name) : []

        return [
          respond(
            message,
            spans.map(span => ({
              uri: params.textDocument.uri,
              range: toRange(span),
            })),
          ),
        ]
      }

      case 'textDocument/rename': {
        const params = message.params as RenameParams
        const index = this.indexes.get(params.textDocument.uri)
        const ref = index && referenceAt(index, params.position)

        if (!ref) {
          return [respond(message, null)]
        }

        const edits = occurrencesOf(index, ref.name).map(span => ({
          range: toRange(span),
          newText: params.newName,
        }))

        return [
          respond(message, {
            changes: { [params.textDocument.uri]: edits },
          }),
        ]
      }

      case 'textDocument/documentSymbol': {
        const params = message.params as TextDocumentParams
        const index = this.indexes.get(params.textDocument.uri)
        const symbols = index
          ? [...index.definitions.values()]
              .filter(
                d =>
                  d.kind === 'function' ||
                  d.kind === 'type' ||
                  d.kind === 'trait',
              )
              .map(d => ({
                name: d.name,
                detail: d.detail,
                kind: SYMBOL_KIND[d.kind],
                range: toRange(d.span),
                selectionRange: toRange(d.span),
              }))
          : []

        return [respond(message, symbols)]
      }

      case 'textDocument/completion': {
        const params = message.params as PositionParams
        const uri = params.textDocument.uri
        const index = this.indexes.get(uri)
        const program = this.programs.get(uri)
        const text = this.documents.get(uri)
        const scope = index ? scopeAt(index, params.position) : []
        const line =
          text?.split('\n')[params.position.line]?.slice(
            0,
            params.position.character,
          ) ?? ''

        // import-path completion: `load @scope/pkg/...` offers the modules available under that prefix
        const loadPath = /^\s*load\s+(@\S*)$/.exec(line)?.[1]
        const filePath = pathFor(uri)

        if (loadPath !== undefined && filePath) {
          const root = findProjectRoot(filePath)
          const items = root
            ? moduleCompletions(root, loadPath).map(m => ({
                label: m.name,
                kind: m.isDir ? KIND_FOLDER : KIND_MODULE,
              }))
            : []

          if (items.length) {
            return [respond(message, { isIncomplete: false, items })]
          }
        }

        // export completion: `find <partial>` inside a `load` block offers that module's top-level definitions
        if (/^\s*find\s+\w*$/.test(line) && text) {
          const importPath = enclosingLoad(text, params.position.line)
          const resolve = resolverFor(uri)
          const exp =
            importPath && resolve
              ? moduleExports(importPath, resolve)
              : undefined
          const items = (exp?.defs ?? []).map(d => ({
            label: d.name,
            kind: EXPORT_KIND[d.kind] ?? KIND_MODULE,
            detail: d.kind,
          }))

          if (items.length) {
            return [respond(message, { isIncomplete: false, items })]
          }
        }

        // member completion: after `<receiver>/`, resolve the receiver's type and offer that type's fields + methods
        if (text && program) {
          const receiver = memberReceiver(line)
          const typeName = receiver
            ? leadingName(scope.find(d => d.name === receiver)?.detail ?? '')
            : undefined

          if (typeName) {
            const { fields, methods } = memberMaps(program)
            const fs = fields.get(typeName) ?? []
            const ms = methods.get(typeName) ?? []

            if (fs.length || ms.length) {
              return [
                respond(message, {
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
                }),
              ]
            }
          }
        }

        // argument-type ranking: inside a call, the type the current argument expects. A scope value of that exact type
        // ranks to the very top.
        const call = program ? callAt(program, params.position) : undefined
        const sig = call ? index?.signatures.get(call.name) : undefined
        const expected = sig?.params[call!.activeParam]?.type

        // default: in-scope symbols first (a type match floats up), then imported callables (from the merged program,
        // which the document-scoped index does not carry), then keyword snippets
        const fromScope = scope.map(d => ({
          label: d.name,
          kind: COMPLETION_KIND[d.kind],
          detail: d.detail,
          // a value matching the expected argument type sorts to `0`, ahead of the rest of the scope at `1`
          sortText:
            expected && d.detail === expected ? `0${d.name}` : `1${d.name}`,
        }))
        const scopeNames = new Set(scope.map(d => d.name))
        const fromImports = program
          ? mergedTopLevel(program)
              .filter(d => !scopeNames.has(d.name))
              .map(d => ({
                label: d.name,
                kind: d.kind,
                detail: d.detail,
                sortText: `2${d.name}`,
              }))
          : []

        return [
          respond(message, {
            isIncomplete: false,
            items: [...fromScope, ...fromImports, ...keywordItems()],
          }),
        ]
      }

      case 'textDocument/signatureHelp': {
        const params = message.params as PositionParams
        const program = this.programs.get(params.textDocument.uri)
        const index = this.indexes.get(params.textDocument.uri)
        const call = program && callAt(program, params.position)
        const sig = call && index?.signatures.get(call.name)

        if (!call || !sig) {
          return [respond(message, null)]
        }

        const label = `${call.name}(${sig.params
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

      case 'textDocument/inlayHint': {
        const params = message.params as {
          textDocument: { uri: string }
          range: { start: { line: number }; end: { line: number } }
        }
        const program = this.documentPrograms.get(params.textDocument.uri)
        const text = this.documents.get(params.textDocument.uri)

        if (!program || !text) {
          return [respond(message, [])]
        }

        return [respond(message, inlayHints(program, text, params.range))]
      }

      case 'textDocument/codeLens': {
        // a reference count above each top-level definition, from the document-scoped index
        const uri = (message.params as TextDocumentParams).textDocument
          .uri
        const index = this.indexes.get(uri)

        if (!index) {
          return [respond(message, [])]
        }

        const lenses = [...index.definitions.values()]
          .filter(
            d =>
              d.kind === 'function' ||
              d.kind === 'type' ||
              d.kind === 'trait',
          )
          .map(d => {
            // occurrences include the definition itself, so subtract it
            const refs = Math.max(
              0,
              occurrencesOf(index, d.name).length - 1,
            )
            return {
              range: toRange(d.span),
              command: {
                title: `${refs} reference${refs === 1 ? '' : 's'}`,
                command: '',
              },
            }
          })

        return [respond(message, lenses)]
      }

      case 'textDocument/codeAction': {
        // auto-import: for each "unknown name" diagnostic in range whose name a linked package exports, offer a quick
        // fix that loads it (a `find` under an existing `load` of that module, else a new load block).
        const params = message.params as {
          textDocument: { uri: string }
          context?: {
            diagnostics?: {
              range: {
                start: { line: number; character: number }
                end: { line: number; character: number }
              }
            }[]
          }
        }
        const uri = params.textDocument.uri
        const text = this.documents.get(uri)
        const filePath = pathFor(uri)
        const root = filePath ? findProjectRoot(filePath) : undefined

        if (!text || !root) {
          return [respond(message, [])]
        }

        const actions: unknown[] = []
        const seen = new Set<string>()

        for (const diag of params.context?.diagnostics ?? []) {
          const name = nameInRange(text, diag.range)

          if (!name || seen.has(name)) {
            continue
          }

          seen.add(name)
          const found = findModuleExporting(root, name)

          if (!found) {
            continue
          }

          actions.push({
            title: `Import ${name} from ${found.importPath}`,
            kind: 'quickfix',
            edit: {
              changes: {
                [uri]: [importEdit(text, found.importPath, name)],
              },
            },
          })
        }

        return [respond(message, actions)]
      }

      default:
        // an unknown request still needs a response; an unknown notification is ignored
        return message.id !== undefined ? [respond(message, null)] : []
    }
  }

  // recompile a document, store its typed program and symbol index, and produce the diagnostics notification
  private async refresh(uri: string, text: string): Promise<Message> {
    this.documents.set(uri, text)

    const result = await this.analyzerFor(uri).analyze({
      file: uri,
      text,
    })

    if (result.program) {
      // the merged program drives full-type features (hover, signature help, completion's imported names); the symbol
      // index is built from the document's own statements so navigation (definitions, references, rename, symbols)
      // never leaks in spans from imported modules.
      this.programs.set(uri, result.program)
      this.documentPrograms.set(
        uri,
        result.documentProgram ?? result.program,
      )
      const index = buildIndex(result.documentProgram ?? result.program)
      // overlay whole-program signatures (span-free), so signature help and argument-type ranking also work for
      // imported functions, which the document-scoped index does not carry.
      for (const [name, sig] of signaturesOf(result.program)) {
        if (!index.signatures.has(name)) {
          index.signatures.set(name, sig)
        }
      }
      this.indexes.set(uri, index)
    } else {
      this.programs.delete(uri)
      this.documentPrograms.delete(uri)
      this.indexes.delete(uri)
    }

    return notify('textDocument/publishDiagnostics', {
      uri,
      diagnostics: result.diagnostics.map(
        toLspDiagnostic,
      ) satisfies LspDiagnostic[],
    })
  }
}

function respond(message: Message, result: unknown): Message {
  return { jsonrpc: '2.0', id: message.id, result }
}

function notify(method: string, params: unknown): Message {
  return { jsonrpc: '2.0', method, params }
}
