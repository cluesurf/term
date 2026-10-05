// A match whose subject is held in a block (`const __at1 = ...`) right after a statement ending in a parenthesized value
// (`let markers = ([] as Marker[])`) must parse as TypeScript. tsc read `([] as Marker[])` and the block's `{` as an
// arrow function missing its `=>`, and refused the whole module, which JavaScript runs fine because it inserts the
// semicolon (parser/diagnostic.tree, 2026-10-05). Asks TypeScript's own parser. Run: npx tsx test/compile/held-block.ts
import ts from 'typescript'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

const text = `load @term/base/maybe
  find maybe

load @term/base/list
  find list

form box
  link items
    like maybe, like list, like number
    need false

task items-of
  take value, like box
  like list, like number

  save items, make list
  sift value/items
    case some
      link given
      save items, given
    case none
      push(items, 0)
  back items
`

const built = compile({ file: 'held-block.tree', text }, { resolve: withNativeEnv('node', stdlibResolver()!), library: true, leanOf: () => true } as never)

if (!built.ok) {
  ok('the program builds', false, built.diagnostics.map(d => d.message.split('\n').join(' ')).join(' | '))
} else {
  const source = ts.createSourceFile('held-block.ts', built.typescript, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const parsed = (source as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics
  ok('the emitted module parses as TypeScript', parsed.length === 0, parsed.map(d => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join(' | '))
  ok('the held subject is in its block', /const __at\d+ = __termMaybe\(value\.items\)/.test(built.typescript))
}

console.log(`\nheld-block: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
