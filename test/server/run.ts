// Language server test: the protocol codec round-trips (including a split chunk), and the dispatcher answers
// initialize, publishes diagnostics on open, hovers an inferred type, and clears diagnostics on close.
// Run: npx tsx test/server/run.ts

import { LanguageServer } from '@cluesurf/flow/code/server'
import { MessageReader, encode } from '@cluesurf/flow/code/protocol'
import type { Message } from '@cluesurf/flow/code/protocol'
import { analyze, forEachExpression } from '@cluesurf/flow/code/analyze'
import { buildIndex, referenceAt } from '@cluesurf/flow/code/symbols'

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
    diagnostics: { severity: number; message: string }[]
  }
).diagnostics

expect(
  'didOpen: an undefined name publishes one error diagnostic',
  badDiags.length >= 1 && badDiags[0].severity === 1,
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

const goodDiags = (good[0]!.params as { diagnostics: unknown[] })
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
    {literalStart = {
      line: node.span.start.line,
      character: node.span.start.column,
    }}
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

const hoverContents = (
  hover[0]!.result as {
    contents: { kind: string; value: string }
  } | null
)?.contents

expect('hover: renders markdown', hoverContents?.kind, 'markdown')
expect(
  'hover: the integer literal reports type number',
  hoverContents?.value.includes('number'),
  true,
)

// close the document: diagnostics are cleared
const closed = await server.dispatch({
  jsonrpc: '2.0',
  method: 'textDocument/didClose',
  params: { textDocument: { uri: 'good.tree' } },
})

expect(
  'didClose: clears diagnostics',
  (closed[0]!.params as { diagnostics: unknown[] }).diagnostics
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
  analyze({ file: 'nav.tree', text: NAV }).program,
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
  (refs[0]!.result as unknown[]).length,
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
    changes: Record<string, { newText: string }[]>
  }
).changes['nav.tree']

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

const symNames = (syms[0]!.result as { name: string }[]).map(
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
  comp[0]!.result as { items: { label: string }[] }
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
  sig[0]!.result as { signatures: { label: string }[] } | null
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

// member completion: after `read p/`, offer the record's fields (and nothing else)
const memberDoc =
  'form point\n  link x, like number\n  link y, like number\n\ntask get\n  take p, like point\n  like number\n  send back\n    read p/\n'

await server.dispatch({
  jsonrpc: '2.0',
  method: 'textDocument/didOpen',
  params: {
    textDocument: { uri: 'file:///member.tree', text: memberDoc },
  },
})

const memberItems = (
  (
    await server.dispatch({
      jsonrpc: '2.0',
      id: 30,
      method: 'textDocument/completion',
      params: {
        textDocument: { uri: 'file:///member.tree' },
        position: { line: 8, character: 11 },
      },
    })
  )[0]!.result as { items: { label: string }[] }
).items

expect(
  'completion: members after `/` offers record fields',
  memberItems.some(i => i.label === 'x') &&
    memberItems.some(i => i.label === 'y'),
  true,
)
expect(
  'completion: member list is fields only (no keyword noise)',
  memberItems.every(i => i.label === 'x' || i.label === 'y'),
  true,
)

// keyword completion: `task` accepts as a snippet that scaffolds the construct
const kwItems = (
  (
    await server.dispatch({
      jsonrpc: '2.0',
      id: 31,
      method: 'textDocument/completion',
      params: {
        textDocument: { uri: 'file:///member.tree' },
        position: { line: 3, character: 0 },
      },
    })
  )[0]!.result as {
    items: { label: string; insertTextFormat?: number }[]
  }
).items

expect(
  'completion: task keyword is a snippet',
  kwItems.find(i => i.label === 'task')?.insertTextFormat,
  2,
)

// import hints + cross-file navigation need a real project root (the seed package has `link/@cluesurf/base`). A doc uri
// inside the package resolves the stdlib exactly as a build would.
const { pathToFileURL } = await import('node:url')
const { join } = await import('node:path')
const projUri = pathToFileURL(
  join(process.cwd(), 'flow-probe.tree'),
).href

const projServer = new LanguageServer()
await projServer.dispatch({
  jsonrpc: '2.0',
  id: 40,
  method: 'initialize',
  params: {},
})

async function projComplete(
  text: string,
  line: number,
  character: number,
): Promise<string[]> {
  await projServer.dispatch({
    jsonrpc: '2.0',
    method: 'textDocument/didOpen',
    params: { textDocument: { uri: projUri, text } },
  })

  const r = (
    await projServer.dispatch({
      jsonrpc: '2.0',
      id: 41,
      method: 'textDocument/completion',
      params: {
        textDocument: { uri: projUri },
        position: { line, character },
      },
    })
  )[0]!.result as { items: { label: string }[] }

  await projServer.dispatch({
    jsonrpc: '2.0',
    method: 'textDocument/didClose',
    params: { textDocument: { uri: projUri } },
  })

  return r.items.map(i => i.label)
}

// import-path completion: `load @cluesurf/base/code/` lists the stdlib modules
const loadLine = 'load @cluesurf/base/code/'
const modules = await projComplete(`${loadLine}\n`, 0, loadLine.length)
expect(
  'completion: import path lists stdlib modules',
  modules.includes('text') && modules.includes('list'),
  true,
)

// export completion: `find` under a `load` lists that module's definitions
const exports_ = await projComplete(
  'load @cluesurf/base/code/text\n  find \n',
  1,
  7,
)

expect(
  'completion: `find` lists the module exports',
  exports_.includes('split') && exports_.includes('to-upper-case'),
  true,
)

// cross-file go-to-definition: a call to an imported name jumps to its module file
const navDoc =
  'load @cluesurf/base/code/text\n  find to-upper-case\n\ntask shout\n  take m, like text\n  like text\n  send back\n    call to-upper-case\n      read m\n'

await projServer.dispatch({
  jsonrpc: '2.0',
  method: 'textDocument/didOpen',
  params: { textDocument: { uri: projUri, text: navDoc } },
})

const nav = (
  await projServer.dispatch({
    jsonrpc: '2.0',
    id: 42,
    method: 'textDocument/definition',
    params: {
      textDocument: { uri: projUri },
      position: { line: 7, character: 12 },
    },
  })
)[0]!.result as { uri: string } | null

expect(
  'definition: cross-file jump to the imported module',
  nav?.uri.endsWith('deck/base/code/text.tree'),
  true,
)

// document-scoped index: the outline lists only THIS document's definitions, never the imported module's
const docSymbols = (
  await projServer.dispatch({
    jsonrpc: '2.0',
    id: 43,
    method: 'textDocument/documentSymbol',
    params: { textDocument: { uri: projUri } },
  })
)[0]!.result as { name: string }[]

expect(
  'documentSymbol: document-scoped (no import leak)',
  docSymbols.length === 1 && docSymbols[0]?.name === 'shout',
  true,
)

// completion still offers imported callables (from the merged program), alongside the local definitions
const blendComp = await projComplete(navDoc, 2, 0)
expect(
  'completion: offers local + imported callables',
  blendComp.includes('shout') && blendComp.includes('to-upper-case'),
  true,
)

// auto-import code action: an unknown name a linked package exports is offered as a `load`
const importDoc =
  'task shout\n  take m, like text\n  like text\n  send back\n    call to-upper-case\n      read m\n'

await projServer.dispatch({
  jsonrpc: '2.0',
  method: 'textDocument/didOpen',
  params: { textDocument: { uri: projUri, text: importDoc } },
})

const unknownRange = {
  start: { line: 4, character: 9 },
  end: { line: 4, character: 22 },
}

const codeActions = (
  await projServer.dispatch({
    jsonrpc: '2.0',
    id: 44,
    method: 'textDocument/codeAction',
    params: {
      textDocument: { uri: projUri },
      range: unknownRange,
      context: { diagnostics: [{ range: unknownRange }] },
    },
  })
)[0]!.result as { title: string }[]

expect(
  'codeAction: auto-imports an unknown name from its module',
  codeActions.some(
    a =>
      a.title.includes('to-upper-case') &&
      a.title.includes('@cluesurf/base/code/text'),
  ),
  true,
)

// argument-type ranking: in a call, a scope value of the expected type sorts ahead of one that does not
const rankDoc =
  'task double\n  take value, like number\n  like number\n  send back\n    call add\n      read value\n      read value\n\ntask use\n  take amount, like number\n  take label, like text\n  like number\n  send back\n    call double\n      a\n'

await server.dispatch({
  jsonrpc: '2.0',
  method: 'textDocument/didOpen',
  params: { textDocument: { uri: 'file:///rank.tree', text: rankDoc } },
})

const rankItems = (
  (
    await server.dispatch({
      jsonrpc: '2.0',
      id: 50,
      method: 'textDocument/completion',
      params: {
        textDocument: { uri: 'file:///rank.tree' },
        position: { line: 14, character: 7 },
      },
    })
  )[0]!.result as { items: { label: string; sortText?: string }[] }
).items

const amountSort =
  rankItems.find(i => i.label === 'amount')?.sortText ?? 'z'

const labelSort =
  rankItems.find(i => i.label === 'label')?.sortText ?? 'z'

expect(
  'completion: argument-type match ranks first',
  amountSort < labelSort,
  true,
)

// code lens: a reference count above each definition
const lensDoc =
  'task square\n  take n, like number\n  like number\n  send back\n    read n\n\ntask run\n  take n, like number\n  like number\n  send back\n    call square\n      read n\n'

await server.dispatch({
  jsonrpc: '2.0',
  method: 'textDocument/didOpen',
  params: { textDocument: { uri: 'file:///lens.tree', text: lensDoc } },
})

const lenses = (
  await server.dispatch({
    jsonrpc: '2.0',
    id: 60,
    method: 'textDocument/codeLens',
    params: { textDocument: { uri: 'file:///lens.tree' } },
  })
)[0]!.result as { command: { title: string } }[]

expect(
  'codeLens: reports the reference count per definition',
  lenses.some(l => l.command.title === '1 reference'),
  true,
)

// inlay hints: an un-annotated binding shows its inferred type inline
const inlayDoc =
  'task demo\n  like number\n  save x\n    code 5\n  send back\n    read x\n'

await server.dispatch({
  jsonrpc: '2.0',
  method: 'textDocument/didOpen',
  params: {
    textDocument: { uri: 'file:///inlay.tree', text: inlayDoc },
  },
})

const hints = (
  await server.dispatch({
    jsonrpc: '2.0',
    id: 70,
    method: 'textDocument/inlayHint',
    params: {
      textDocument: { uri: 'file:///inlay.tree' },
      range: {
        start: { line: 0, character: 0 },
        end: { line: 20, character: 0 },
      },
    },
  })
)[0]!.result as { label: string }[]

expect(
  'inlayHint: inferred type of an un-annotated binding',
  hints.some(h => h.label === ': number'),
  true,
)

// semantic tokens: 5-int delta-encoded tokens, the first being the `square` declaration (function + declaration)
const semDoc =
  'task square\n  take n, like number\n  like number\n  send back\n    read n\n'

await server.dispatch({
  jsonrpc: '2.0',
  method: 'textDocument/didOpen',
  params: { textDocument: { uri: 'file:///sem.tree', text: semDoc } },
})

const sem = (
  await server.dispatch({
    jsonrpc: '2.0',
    id: 80,
    method: 'textDocument/semanticTokens/full',
    params: { textDocument: { uri: 'file:///sem.tree' } },
  })
)[0]!.result as { data: number[] }

expect(
  'semanticTokens: emits 5-int tokens',
  sem.data.length > 0 && sem.data.length % 5 === 0,
  true,
)
expect(
  'semanticTokens: first token is a function declaration',
  sem.data[3] === 0 && sem.data[4] === 1,
  true,
)

console.log(`\nserver: ${pass} pass, ${fail} fail`)

if (fail > 0) {process.exit(1)}
