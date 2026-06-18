// Language server test: the protocol codec round-trips (including a split chunk), and the dispatcher answers
// initialize, publishes diagnostics on open, hovers an inferred type, and clears diagnostics on close.
// Run: npx tsx test/server/run.ts

import { LanguageServer } from '@/code/server/server'
import { MessageReader, encode } from '@/code/server/protocol'
import type { Message } from '@/code/server/protocol'
import { analyze, forEachExpression } from '@/code/server/analyze'

let pass = 0
let fail = 0
function expect(name: string, got: unknown, want: unknown): void {
  if (got === want) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)
  }
}

// --- protocol codec ---
const reader = new MessageReader()
const framed = encode({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
const decoded = reader.append(framed)
expect('codec: a framed message round-trips', decoded.length === 1 && decoded[0]!.method === 'initialize', true)

// a message split across two chunks is only surfaced once complete
const split = new MessageReader()
const frame2 = encode({ jsonrpc: '2.0', method: 'noop' })
const cut = Math.floor(frame2.length / 2)
expect('codec: a half-arrived message is buffered', split.append(frame2.slice(0, cut)).length, 0)
expect('codec: the rest completes the message', split.append(frame2.slice(cut)).length, 1)

// --- dispatcher ---
const server = new LanguageServer()

const init = server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
const caps = (init[0]!.result as { capabilities: { hoverProvider: boolean } }).capabilities
expect('initialize: advertises hover support', caps.hoverProvider, true)

// open a document with an undefined name: a diagnostic must be published
const BAD = 'task f\n  like number\n  back\n    read nope\n'
const opened = server.dispatch({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: 'bad.tree', text: BAD } } })
const badDiags = (opened[0]!.params as { diagnostics: Array<{ severity: number; message: string }> }).diagnostics
expect('didOpen: an undefined name publishes one error diagnostic', badDiags.length >= 1 && badDiags[0]!.severity === 1, true)

// open a valid document: no error diagnostics, then hover an integer literal and expect `number`
const GOOD = 'task add-one\n  take n, like number\n  like number\n  back\n    call add\n      read n\n      mark 1\n'
const good = server.dispatch({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: 'good.tree', text: GOOD } } })
const goodDiags = (good[0]!.params as { diagnostics: Array<unknown> }).diagnostics
expect('didOpen: a valid document publishes no errors', goodDiags.every((d) => (d as { severity: number }).severity !== 1), true)

// locate the integer literal `1` (its inferred type is number) and hover at its start
const program = analyze({ file: 'good.tree', text: GOOD }).program!
let literalStart: { line: number; character: number } | undefined
forEachExpression(program, (node) => {
  if (node.form === 'integer' && node.value === 1) literalStart = { line: node.span.start.line, character: node.span.start.column }
})
const hover = server.dispatch({ jsonrpc: '2.0', id: 2, method: 'textDocument/hover', params: { textDocument: { uri: 'good.tree' }, position: literalStart! } })
const hoverValue = (hover[0]!.result as { contents: { value: string } } | null)?.contents.value
expect('hover: the integer literal reports type number', hoverValue, 'number')

// close the document: diagnostics are cleared
const closed = server.dispatch({ jsonrpc: '2.0', method: 'textDocument/didClose', params: { textDocument: { uri: 'good.tree' } } })
expect('didClose: clears diagnostics', (closed[0]!.params as { diagnostics: Array<unknown> }).diagnostics.length, 0)

// an unknown request still gets a response (never hangs the client)
const unknown: Message = { jsonrpc: '2.0', id: 9, method: 'textDocument/somethingNew', params: {} }
expect('unknown request: still answered', server.dispatch(unknown)[0]!.id, 9)

console.log(`\nserver: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
