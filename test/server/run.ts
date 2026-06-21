// Language server test: the protocol codec round-trips (including a split chunk), and the dispatcher answers
// initialize, publishes diagnostics on open, hovers an inferred type, and clears diagnostics on close.
// Run: npx tsx test/server/run.ts

import { LanguageServer } from '@cluesurf/flow/code/server'
import {
  MessageReader,
  encode,
} from '@cluesurf/flow/code/protocol'
import type { Message } from '@cluesurf/flow/code/protocol'
import {
  analyze,
  forEachExpression,
} from '@cluesurf/flow/code/analyze'
import {
  buildIndex,
  referenceAt,
} from '@cluesurf/flow/code/symbols'

let pass = 0
let fail = 0
function expect(name: string, got: unknown, want: unknown): void {
  if (got === want) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (got ${JSON.stringify(
        got,
      )}, want ${JSON.stringify(want)})`,
    )
  }
}

// --- protocol codec ---
const reader = new MessageReader()
const framed = encode({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {},
})
const decoded = reader.append(framed)
expect(
  'codec: a framed message round-trips',
  decoded.length === 1 && decoded[0]!.method === 'initialize',
  true,
)

// a message split across two chunks is only surfaced once complete
const split = new MessageReader()
const frame2 = encode({ jsonrpc: '2.0', method: 'noop' })
const cut = Math.floor(frame2.length / 2)
expect(
  'codec: a half-arrived message is buffered',
  split.append(frame2.slice(0, cut)).length,
  0,
)
expect(
  'codec: the rest completes the message',
  split.append(frame2.slice(cut)).length,
  1,
)

// --- dispatcher ---
const server = new LanguageServer()

const init = await server.dispatch({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {},
})
const caps = (
  init[0]!.result as { capabilities: { hoverProvider: boolean } }
).capabilities
expect('initialize: advertises hover support', caps.hoverProvider, true)

// open a document with an undefined name: a diagnostic must be published
const BAD = 'task f\n  like number\n  back\n    read nope\n'
const opened = await server.dispatch({
  jsonrpc: '2.0',
  method: 'textDocument/didOpen',
  params: { textDocument: { uri: 'bad.tree', text: BAD } },
})
const badDiags = (
  opened[0]!.params as {
    diagnostics: Array<{ severity: number; message: string }>
  }
).diagnostics
expect(
  'didOpen: an undefined name publishes one error diagnostic',
  badDiags.length >= 1 && badDiags[0]!.severity === 1,
  true,
)

// open a valid document: no error diagnostics, then hover an integer literal and expect `number`
const GOOD =
  'task add-one\n  take n, like number\n  like number\n  back\n    call add\n      read n\n      code 1\n'
const good = await server.dispatch({
  jsonrpc: '2.0',
  method: 'textDocument/didOpen',
  params: { textDocument: { uri: 'good.tree', text: GOOD } },
})
const goodDiags = (good[0]!.params as { diagnostics: Array<unknown> })
  .diagnostics
expect(
  'didOpen: a valid document publishes no errors',
  goodDiags.every(d => (d as { severity: number }).severity !== 1),
  true,
)

// locate the integer literal `1` (its inferred type is number) and hover at its start
const program = analyze({ file: 'good.tree', text: GOOD }).program!
let literalStart: { line: number; character: number } | undefined
forEachExpression(program, node => {
  if (node.form === 'integer' && node.value === 1)
    literalStart = {
      line: node.span.start.line,
      character: node.span.start.column,
    }
})
const hover = await server.dispatch({
  jsonrpc: '2.0',
  id: 2,
  method: 'textDocument/hover',
  params: {
    textDocument: { uri: 'good.tree' },
    position: literalStart!,
  },
})
const hoverValue = (
  hover[0]!.result as { contents: { value: string } } | null
)?.contents.value
expect(
  'hover: the integer literal reports type number',
  hoverValue,
  'number',
)

// close the document: diagnostics are cleared
const closed = await server.dispatch({
  jsonrpc: '2.0',
  method: 'textDocument/didClose',
  params: { textDocument: { uri: 'good.tree' } },
})
expect(
  'didClose: clears diagnostics',
  (closed[0]!.params as { diagnostics: Array<unknown> }).diagnostics
    .length,
  0,
)

// --- navigation: definition / references / rename / symbols / completion / signature help ---
const NAV =
  'task helper\n  take n, like number\n  like number\n  back\n    call add\n      read n\n      code 1\n\ntask runner\n  like number\n  back\n    call helper\n      code 5\n'
const navServer = new LanguageServer()
await navServer.dispatch({
  jsonrpc: '2.0',
  method: 'textDocument/didOpen',
  params: { textDocument: { uri: 'nav.tree', text: NAV } },
})

// locate the `helper` reference at the call site (its span drives the position-based queries)
const navIndex = buildIndex(
  analyze({ file: 'nav.tree', text: NAV }).program!,
)
const callRef = navIndex.references.find(r => r.name === 'helper')!
const callPos = {
  line: callRef.span.start.line,
  character: callRef.span.start.character ?? callRef.span.start.column,
}
const at = {
  line: callRef.span.start.line,
  character: callRef.span.start.column,
}

const def = await navServer.dispatch({
  jsonrpc: '2.0',
  id: 10,
  method: 'textDocument/definition',
  params: { textDocument: { uri: 'nav.tree' }, position: at },
})
const defRange = (
  def[0]!.result as { range: { start: { line: number } } } | null
)?.range
expect(
  'definition: jumps to the function declaration (line 0)',
  defRange?.start.line,
  0,
)

const refs = await navServer.dispatch({
  jsonrpc: '2.0',
  id: 11,
  method: 'textDocument/references',
  params: { textDocument: { uri: 'nav.tree' }, position: at },
})
expect(
  'references: finds the call site and the declaration',
  (refs[0]!.result as Array<unknown>).length,
  2,
)

const rename = await navServer.dispatch({
  jsonrpc: '2.0',
  id: 12,
  method: 'textDocument/rename',
  params: {
    textDocument: { uri: 'nav.tree' },
    position: at,
    newName: 'assist',
  },
})
const renameEdits = (
  rename[0]!.result as {
    changes: Record<string, Array<{ newText: string }>>
  }
).changes['nav.tree']!
expect(
  'rename: edits every occurrence to the new name',
  renameEdits.length === 2 &&
    renameEdits.every(e => e.newText === 'assist'),
  true,
)

const syms = await navServer.dispatch({
  jsonrpc: '2.0',
  id: 13,
  method: 'textDocument/documentSymbol',
  params: { textDocument: { uri: 'nav.tree' } },
})
const symNames = (syms[0]!.result as Array<{ name: string }>).map(
  s => s.name,
)
expect(
  'documentSymbol: lists the top-level functions',
  symNames.includes('helper') && symNames.includes('runner'),
  true,
)

const comp = await navServer.dispatch({
  jsonrpc: '2.0',
  id: 14,
  method: 'textDocument/completion',
  params: { textDocument: { uri: 'nav.tree' }, position: at },
})
const compLabels = (
  comp[0]!.result as { items: Array<{ label: string }> }
).items.map(i => i.label)
expect(
  'completion: offers in-scope names and keywords',
  compLabels.includes('helper') && compLabels.includes('call'),
  true,
)

const sig = await navServer.dispatch({
  jsonrpc: '2.0',
  id: 15,
  method: 'textDocument/signatureHelp',
  params: { textDocument: { uri: 'nav.tree' }, position: callPos },
})
const sigLabel = (
  sig[0]!.result as { signatures: Array<{ label: string }> } | null
)?.signatures[0]?.label
expect(
  'signatureHelp: shows the callee signature',
  typeof sigLabel === 'string' && sigLabel.startsWith('helper('),
  true,
)

// initialize advertises the new capabilities
const caps2 = (
  (
    await server.dispatch({
      jsonrpc: '2.0',
      id: 20,
      method: 'initialize',
      params: {},
    })
  )[0]!.result as { capabilities: Record<string, unknown> }
).capabilities
expect(
  'initialize: advertises definition + completion + rename',
  !!caps2.definitionProvider &&
    !!caps2.completionProvider &&
    !!caps2.renameProvider,
  true,
)

// an unknown request still gets a response (never hangs the client)
const unknown: Message = {
  jsonrpc: '2.0',
  id: 9,
  method: 'textDocument/somethingNew',
  params: {},
}
expect(
  'unknown request: still answered',
  (await server.dispatch(unknown))[0]!.id,
  9,
)

console.log(`\nserver: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
