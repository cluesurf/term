// check/type-names.ts: every name a type or a construction uses is one the program has. A misspelled TYPE used to be
// read as no type at all (2026-10-03). A misspelled CONSTRUCTION built: `make unit` wrote `{}` on TypeScript wherever
// the slot was `like unknown`, and only the native compilers refused it (the compile/memo port, 2026-10-04).
// Run: npx tsx test/check/construction-names.ts

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

function messages(text: string): string[] {
  const result = compile({ file: 'names.tree', text }, { resolve: withNativeEnv('node', stdlibResolver()!) })

  return result.ok ? [] : result.diagnostics.map(d => `${d.name}: ${d.message}`)
}

const head = `load @term/base/list
  find list

form box
  link value, like unknown

form light
  case red
  case green
`

const cases: [string, string, boolean][] = [
  ['a form builds', 'make box\n      bind value, 1', true],
  ['a case builds', 'make box\n      bind value, make red', true],
  ['a qualified case builds', 'make box\n      bind value, make light/red', true],
  ['an empty hash builds', 'make box\n      bind value, make hash', true],
  ['an empty list builds', 'make box\n      bind value, make list', true],
  ['a list of values builds', 'make box\n      bind value, make list(1, 2)', true],
  ['`make unit` is refused', 'make box\n      bind value, make unit', false],
  ['a misspelled form is refused', 'make box\n      bind value, make bxo', false],
  ['a misspelled case is refused', 'make box\n      bind value, make rde', false],
]

for (const [name, value, builds] of cases) {
  const found = messages(`${head}\ntask one\n  like box\n\n  back\n    ${value}\n`)
  const refused = found.some(m => m.includes('names no form'))

  ok(name, builds ? found.length === 0 : refused, found.join(' | '))
}

const typo = messages(`${head}\ntask one\n  take b, like bxo\n  like box\n\n  back b\n`)
ok('a misspelled type is refused, as before', typo.some(m => m.includes('the type "bxo" is not defined')), typo.join(' | '))

const named = messages(`${head}\ntask one\n  like box\n\n  back\n    make box\n      bind value, make unit\n`)
ok('the refusal names the construction and the task', named.some(m => m.includes('`make unit` names no form (in `one`)')), named.join(' | '))

// `make hash` is the native map, its entries `save <key>, <value>` lines. With entries it built an EMPTY map until
// 2026-10-05, the lines dropped without a word, while `make find`, a second spelling, kept them
const map = (word: string, entries: string): ReturnType<typeof compile> =>
  compile(
    { file: 'names.tree', text: `task sizes\n  like number\n  save m\n    make ${word}\n${entries}  back m/size\n` },
    { resolve: withNativeEnv('node', stdlibResolver()!) },
  )
const literal = map('hash', '      save a, 1\n      save b, 2\n')
ok('`make hash` keeps its `save` entries', literal.ok && literal.typescript.includes('new Map([["a", 1], ["b", 2]])'), literal.ok ? literal.typescript : literal.diagnostics.map(d => d.message).join(' | '))
const old = map('find', '      save a, 1\n')
ok('`make find` is refused, naming `make hash`', !old.ok && old.diagnostics.some(d => d.message.includes('older spelling of `make hash`')), old.ok ? 'built' : old.diagnostics.map(d => d.message).join(' | '))
const bound = map('hash', '      bind a, 1\n')
ok('a `bind` under `make hash` is refused, not dropped', !bound.ok && bound.diagnostics.some(d => d.message.includes('not a `bind`')), bound.ok ? 'built' : bound.diagnostics.map(d => d.message).join(' | '))

// a program's OWN `hash` (@term/host's `data` has `case hash / link list`) is built with `bind`, as any case is
const own = compile(
  { file: 'own.tree', text: `form data\n  case hash\n    link list, like text\n  case none\n\ntask wrap\n  like data\n  back\n    make hash\n      bind list, <a>\n` },
  { resolve: withNativeEnv('node', stdlibResolver()!) },
)
ok('a `bind` under `make hash` builds the program\'s own `hash` case', own.ok && own.typescript.includes('"hash"'), own.ok ? own.typescript.slice(0, 300) : own.diagnostics.map(d => d.message).join(' | '))

console.log(`\nconstruction-names: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
