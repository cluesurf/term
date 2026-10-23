// A face over the server's ports (term-cli-in-term-0100 to 0104, live since term-cli-in-term-0117):
// language-server.tree holds the server's record and its lifecycle, request-loop.tree the dispatcher, and the
// request modules beside them (document-sync, navigation, symbol-requests, semantic-coloring, inlay-hinting,
// call-hierarchy, completion, code-actions) every case of the original's `handle`. The original is kept at
// tmp/retired/flow/server.ts. The editor's server starts from pump.tree (main.ts) and never reaches this file; its
// TypeScript callers (test/server/*.ts, test/flow/lsp.ts) keep this API until they move to the port's.
// `LanguageServer` keeps the port's `language-server` record and calls its tasks, `semanticTokens` answers `{ data }`
// and takes the identity mapping when none is given, and `inlayHints` takes the original's options record.
import * as emittedServer from '@term/flow/code/language-server'
import * as emittedLoop from '@term/flow/code/request-loop'
import * as emittedColoring from '@term/flow/code/semantic-coloring'
import * as emittedHinting from '@term/flow/code/inlay-hinting'
import * as emittedGeometry from '@term/flow/code/geometry'
import type { Message } from '@term/flow/code/protocol'

// the emitted ports may load as CommonJS (deck/flow/package.json has no `"type": "module"`), exports under `default`
const unwrap = (module: unknown): any => (module as { default?: unknown }).default ?? module
const ls = unwrap(emittedServer)
const rl = unwrap(emittedLoop)
const coloring = unwrap(emittedColoring)
const hinting = unwrap(emittedHinting)
const geometry = unwrap(emittedGeometry)

export type ServerOptions = {
  resolve?: (...args: any[]) => any
  roleOf?: (file: string) => string | null | undefined
  leanOf?: (file: string) => boolean | undefined
  deckOf?: (file: string) => { name: string; root: string } | undefined
  debounce?: number
  send?: (message: Message) => void
}

export class LanguageServer {
  private readonly record: any

  constructor(options?: ServerOptions | ((...args: any[]) => any)) {
    this.record = ls.makeLanguageServer(options)
  }

  isShutDown(): boolean {
    return ls.isShutDown(this.record)
  }

  held(): { documents: number; files: number; timers: number } {
    return ls.held(this.record)
  }

  cancel(id: number | string | undefined | null): void {
    ls.cancel(this.record, id)
  }

  dispatch(message: Message): Promise<Message[]> {
    return rl.dispatch(this.record, message)
  }
}

export function semanticTokens(text: string, index: any, map?: any): { data: number[] } {
  return { data: coloring.semanticTokens(text, index, map ?? geometry.identityMapping()) }
}

export function inlayHints(
  program: any[],
  text: string,
  range: { start: { line: number }; end: { line: number } },
  options?: { lean?: boolean; signatures?: Map<string, any> },
): any[] {
  const signatures = options?.signatures ? { form: 'some', value: options.signatures } : { form: 'none' }
  return hinting.inlayHints(program, text, range, Boolean(options?.lean), signatures)
}
