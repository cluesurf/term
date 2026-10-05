// A keystroke in the editor builds one unit (note/term/plan/incremental-best-in-class.md, step 11). The language server
// analyzes a document through units, with each unit's answer, each module's walk and each parse kept for every
// document, so an edit builds the edited module's unit and reads the standard library's from memory. Here a document
// that loads the standard library is opened, then edited ten times, one of them into an error and back. Every analysis
// must say what a whole compile says, and a keystroke must cost less than compiling the document whole.
// Run: npx tsx test/server/keystroke.ts

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LanguageServer } from '@term/flow/code/server'
import type { Message } from '@term/flow/code/protocol'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'

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

const root = realpathSync(mkdtempSync(join(tmpdir(), 'keystroke-')))
mkdirSync(join(root, 'code'), { recursive: true })
writeFileSync(join(root, 'deck.tree'), `deck @probe/keystroke\n  mark <0.0.1>\n`)

const file = join(root, 'code', 'base.tree')
const uri = pathToFileURL(file).href
const textOf = (n: number, broken = false): string =>
  `load @term/base/text\n  find trim\n\nload @term/base/list\n  find sort\n\ntask greet\n  take who, like text\n  like text\n  back trim(<${'x'.repeat(n)} {who}>)\n\ntask count\n  like number\n  back ${broken ? '<not a number>' : String(n)}\n`

writeFileSync(file, textOf(0))

let id = 1
const server = new LanguageServer({})
const dispatch = (message: Record<string, unknown>): Promise<Message[]> => server.dispatch({ jsonrpc: '2.0', ...message })

// the document's errors as the server has them now: a pull settles any pending edit first
const errorsNow = async (): Promise<number> => {
  const out = await dispatch({ id: id++, method: 'textDocument/diagnostic', params: { textDocument: { uri } } })
  const items = ((out[0]?.result as { items?: { severity: number }[] } | undefined)?.items ?? []).filter(d => d.severity === 1)

  return items.length
}

await dispatch({ id: id++, method: 'initialize', params: { capabilities: { textDocument: { diagnostic: {} } } } })

let started = Date.now()
await dispatch({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'tree', version: 1, text: textOf(0) } } })
ok('the document opens clean', (await errorsNow()) === 0)
const opened = Date.now() - started

const times: number[] = []
const wrong: string[] = []

for (let n = 1; n <= 10; n++) {
  const broken = n === 5
  started = Date.now()
  await dispatch({ method: 'textDocument/didChange', params: { textDocument: { uri, version: n + 1 }, contentChanges: [{ text: textOf(n, broken) }] } })
  const errors = await errorsNow()
  times.push(Date.now() - started)

  if ((errors > 0) !== broken) {
    wrong.push(`edit ${n}: ${errors} errors`)
  }
}

ok('every edit is analyzed to the right answer, the broken one with its error', wrong.length === 0, wrong.join(', '))

// what the same document costs compiled whole, as the server compiled it before units
started = Date.now()
const whole = compile({ file, text: textOf(11) }, { resolve: projectResolver(root), optimize: false })
const merged = Date.now() - started
ok('the whole compile agrees the document builds', whole.ok)

const keystroke = times.slice(1).reduce((a, b) => a + b, 0) / (times.length - 1)
console.log(`      open ${opened} ms, a keystroke ${Math.round(keystroke)} ms on average, a whole compile ${merged} ms`)
ok('a keystroke costs less than compiling the document whole', keystroke < merged, `${Math.round(keystroke)} ms against ${merged} ms`)

console.log(`\nserver/keystroke: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
