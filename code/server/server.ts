// The Language Server itself: a pure message dispatcher over the LSP protocol. `dispatch` takes one incoming message
// and returns the outgoing messages (responses and notifications) to write back, so it is fully testable without any
// streams. It keeps a document store, the last good typed program per file, and a symbol index built from it, and
// recompiles on every edit (the incremental cache makes an unchanged module a hit). Navigation (definition,
// references, rename, symbols, completion, signature help) are queries over the index. The node entry point
// (main.ts) pumps stdin/stdout into it.

import type { Message } from '@/code/server/protocol'
import { analyze, hoverAt, toRange } from '@/code/server/analyze'
import type { LspDiagnostic, LspPosition } from '@/code/server/analyze'
import {
  buildIndex,
  referenceAt,
  occurrencesOf,
  scopeAt,
  callAt,
} from '@/code/server/symbols'
import type { SymbolIndex, SymbolKind } from '@/code/server/symbols'
import { CompileCache } from '@/code/compile/cache'
import type { Resolver } from '@/code/compile/load'
import type { Program } from '@/code/compile/node'

type TextDocumentParams = {
  textDocument: { uri: string; text?: string }
}
type ChangeParams = {
  textDocument: { uri: string }
  contentChanges: Array<{ text: string }>
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

export class LanguageServer {
  private readonly documents = new Map<string, string>()
  private readonly programs = new Map<string, Program>()
  private readonly indexes = new Map<string, SymbolIndex>()
  private readonly cache = new CompileCache()
  private shuttingDown = false

  constructor(private readonly resolve?: Resolver) {}

  dispatch(message: Message): Array<Message> {
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
          this.refresh(
            params.textDocument.uri,
            params.textDocument.text ?? '',
          ),
        ]
      }
      case 'textDocument/didChange': {
        const params = message.params as ChangeParams
        return [
          this.refresh(
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
        const type = program
          ? hoverAt(program, params.position)
          : undefined
        return [
          respond(
            message,
            type
              ? { contents: { kind: 'plaintext', value: type } }
              : null,
          ),
        ]
      }
      case 'textDocument/definition': {
        const params = message.params as PositionParams
        const index = this.indexes.get(params.textDocument.uri)
        const ref = index && referenceAt(index, params.position)
        const def = ref && index!.definitions.get(ref.name)
        return [
          respond(
            message,
            def
              ? {
                  uri: params.textDocument.uri,
                  range: toRange(def.span),
                }
              : null,
          ),
        ]
      }
      case 'textDocument/references': {
        const params = message.params as PositionParams
        const index = this.indexes.get(params.textDocument.uri)
        const ref = index && referenceAt(index, params.position)
        const spans = ref ? occurrencesOf(index!, ref.name) : []
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
        if (!ref) return [respond(message, null)]
        const edits = occurrencesOf(index!, ref.name).map(span => ({
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
        const index = this.indexes.get(params.textDocument.uri)
        const fromScope = index
          ? scopeAt(index, params.position).map(d => ({
              label: d.name,
              kind: COMPLETION_KIND[d.kind],
              detail: d.detail,
            }))
          : []
        const keywords = KEYWORDS.map(label => ({ label, kind: 14 }))
        return [
          respond(message, {
            isIncomplete: false,
            items: [...fromScope, ...keywords],
          }),
        ]
      }
      case 'textDocument/signatureHelp': {
        const params = message.params as PositionParams
        const program = this.programs.get(params.textDocument.uri)
        const index = this.indexes.get(params.textDocument.uri)
        const call = program && callAt(program, params.position)
        const sig = call && index?.signatures.get(call.name)
        if (!call || !sig) return [respond(message, null)]
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
      default:
        // an unknown request still needs a response; an unknown notification is ignored
        return message.id !== undefined ? [respond(message, null)] : []
    }
  }

  // recompile a document, store its typed program and symbol index, and produce the diagnostics notification
  private refresh(uri: string, text: string): Message {
    this.documents.set(uri, text)
    const result = analyze(
      { file: uri, text },
      { resolve: this.resolve, cache: this.cache },
    )
    if (result.program) {
      this.programs.set(uri, result.program)
      this.indexes.set(uri, buildIndex(result.program))
    } else {
      this.programs.delete(uri)
      this.indexes.delete(uri)
    }
    return notify('textDocument/publishDiagnostics', {
      uri,
      diagnostics: result.diagnostics satisfies Array<LspDiagnostic>,
    })
  }
}

function respond(message: Message, result: unknown): Message {
  return { jsonrpc: '2.0', id: message.id, result }
}

function notify(method: string, params: unknown): Message {
  return { jsonrpc: '2.0', method, params }
}
