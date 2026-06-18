// The Language Server itself: a pure message dispatcher over the LSP protocol. `dispatch` takes one incoming message
// and returns the outgoing messages (responses and notifications) to write back, so it is fully testable without any
// streams. It keeps a document store and the last good typed program per file, and recompiles on every edit (the
// incremental cache makes an unchanged module a hit). The node entry point (main.ts) pumps stdin/stdout into it.

import type { Message } from '@/code/server/protocol'
import { analyze, hoverAt } from '@/code/server/analyze'
import type { LspDiagnostic } from '@/code/server/analyze'
import { CompileCache } from '@/code/compile/cache'
import type { Resolver } from '@/code/compile/load'
import type { Program } from '@/code/compile/node'

type TextDocumentParams = { textDocument: { uri: string; text?: string } }
type ChangeParams = { textDocument: { uri: string }; contentChanges: Array<{ text: string }> }
type HoverParams = { textDocument: { uri: string }; position: { line: number; character: number } }

export class LanguageServer {
  private readonly documents = new Map<string, string>()
  private readonly programs = new Map<string, Program>()
  private readonly cache = new CompileCache()
  private shuttingDown = false

  constructor(private readonly resolve?: Resolver) {}

  dispatch(message: Message): Array<Message> {
    switch (message.method) {
      case 'initialize':
        return [respond(message, { capabilities: { textDocumentSync: 1, hoverProvider: true } })]
      case 'initialized':
        return []
      case 'shutdown':
        this.shuttingDown = true
        return [respond(message, null)]
      case 'exit':
        return []
      case 'textDocument/didOpen': {
        const params = message.params as TextDocumentParams
        const text = params.textDocument.text ?? ''
        return [this.refresh(params.textDocument.uri, text)]
      }
      case 'textDocument/didChange': {
        const params = message.params as ChangeParams
        const text = params.contentChanges[params.contentChanges.length - 1]?.text ?? ''
        return [this.refresh(params.textDocument.uri, text)]
      }
      case 'textDocument/didClose': {
        const params = message.params as TextDocumentParams
        this.documents.delete(params.textDocument.uri)
        this.programs.delete(params.textDocument.uri)
        // clear the squiggles for a closed file
        return [notify('textDocument/publishDiagnostics', { uri: params.textDocument.uri, diagnostics: [] })]
      }
      case 'textDocument/hover': {
        const params = message.params as HoverParams
        const program = this.programs.get(params.textDocument.uri)
        const type = program ? hoverAt(program, params.position) : undefined
        return [respond(message, type ? { contents: { kind: 'plaintext', value: type } } : null)]
      }
      default:
        // an unknown request still needs a response; an unknown notification is ignored
        return message.id !== undefined ? [respond(message, null)] : []
    }
  }

  // recompile a document, store its typed program, and produce the diagnostics notification
  private refresh(uri: string, text: string): Message {
    this.documents.set(uri, text)
    const result = analyze({ file: uri, text }, { resolve: this.resolve, cache: this.cache })
    if (result.program) this.programs.set(uri, result.program)
    else this.programs.delete(uri)
    return notify('textDocument/publishDiagnostics', { uri, diagnostics: result.diagnostics satisfies Array<LspDiagnostic> })
  }
}

function respond(message: Message, result: unknown): Message {
  return { jsonrpc: '2.0', id: message.id, result }
}

function notify(method: string, params: unknown): Message {
  return { jsonrpc: '2.0', method, params }
}
