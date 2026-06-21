// Language-server tests: the editor features (semantic tokens, inlay hints, hover) over a real typed program.
// Run: npx tsx test/flow/lsp.ts. These were previously untested; this is the LSP coverage for P1.

import { analyze, hoverAt } from '@cluesurf/flow/code/analyze'
import { buildIndex } from '@cluesurf/flow/code/symbols'
import {
  semanticTokens,
  inlayHints,
  LanguageServer,
} from '@cluesurf/flow/code/server'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

function main(): void {
  const text = `task add-them
  take a, like number
  take b, like number
  like number
  save total
    call add
      read a
      read b
  send back, read total
`
  const { program } = analyze({ file: 't.tree', text })
  if (!program) {
    console.log('FAIL  program did not compile')
    process.exit(1)
  }

  const index = buildIndex(program)

  ok(
    'buildIndex records the function definition',
    index.definitions.has('add-them') || index.functions.length > 0,
    JSON.stringify([...index.definitions.keys()]),
  )

  ok(
    'semanticTokens emits a non-empty token stream',
    semanticTokens(text, index).data.length > 0,
  )

  // semantic token data is groups of 5 ints (deltaLine, deltaChar, length, type, mod)
  ok(
    'semanticTokens data is a multiple of 5 (well-formed)',
    semanticTokens(text, index).data.length % 5 === 0,
  )

  // inlay hints suggest the inferred type for the untyped `save total`
  const hints = inlayHints(program, text, {
    start: { line: 0 },
    end: { line: 100 },
  })
  ok(
    'inlayHints suggests a type for an untyped binding',
    hints.length > 0,
    JSON.stringify(hints),
  )

  // hover over `read a` (line 6, the `a`) reports its type
  const hover = hoverAt(program, { line: 6, character: 11 })
  ok('hoverAt reports a type under the cursor', hover !== undefined, JSON.stringify(hover))

  // navigation data: the index carries the references and signatures definition/rename/signature-help query
  ok(
    'the index records references (for go-to-definition / rename)',
    index.references.length > 0,
    String(index.references.length),
  )
  ok(
    'the index records a function signature (for signature help)',
    index.signatures.has('add-them'),
    JSON.stringify([...index.signatures.keys()]),
  )
  ok(
    'the index records function scopes (for document symbols)',
    index.scopes.length > 0,
  )

  console.log(`\nflow-lsp: ${pass} pass, ${fail} fail`)
}

// diagnostic backdating: a re-check that yields the same diagnostics does not re-publish (no editor repaint)
async function backdating(): Promise<void> {
  const server = new LanguageServer()
  const uri = 'bd.tree'
  const bad = `task f\n  like number\n  send back\n    read nope\n`
  const good = `task f\n  like number\n  send back, code 1\n`
  const msg = (method: string, params: unknown) =>
    ({ jsonrpc: '2.0' as const, method, params })
  const publishes = (out: { method?: string }[]): boolean =>
    out.some(m => m.method === 'textDocument/publishDiagnostics')

  const opened = await server.dispatch(
    msg('textDocument/didOpen', { textDocument: { uri, text: bad } }),
  )
  const reSame = await server.dispatch(
    msg('textDocument/didChange', {
      textDocument: { uri },
      contentChanges: [{ text: bad }],
    }),
  )
  const reChanged = await server.dispatch(
    msg('textDocument/didChange', {
      textDocument: { uri },
      contentChanges: [{ text: good }],
    }),
  )

  ok('didOpen publishes diagnostics', publishes(opened))
  ok(
    'a re-check with identical text is backdated (no re-publish)',
    reSame.length === 0,
    JSON.stringify(reSame),
  )
  ok(
    'a real change re-publishes (diagnostics cleared)',
    publishes(reChanged),
  )

  console.log(`\nflow-lsp (backdating): ${pass} pass, ${fail} fail`)
}

async function run(): Promise<void> {
  main()
  await backdating()
}

void run()
