// Kotlin tests a field-less case by identity (kotlin.ts, the `match` case): the case is one `object`, so
// `subject === ChainEnd` is the whole test, one compare where `is` is a type check. Held both ways: List's empty list,
// and two forms naming a case alike, only the field-less one tested by identity, since `===` on a class's instance
// never matches. The meaning fixtures hold the answers on Kotlin.
// Run: npx tsx test/compile/kotlin-identity.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'
import { emitKotlin } from '@term/make/code/compile/kotlin'

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

const TERM = join(import.meta.dirname, '../..')
const kotlin = (text: string, entry: string, file = 'main.tree'): string => {
  const built = compile({ file, text }, { resolve: withNativeEnv('kotlin', stdlibResolver()!), env: 'kotlin', entryPoints: [entry] })

  if (!built.ok) {
    throw new Error(`${file}: ${built.diagnostics[0]?.message}`)
  }

  return emitKotlin(built.program)
}
const lines = (text: string, pattern: RegExp): string => text.split('\n').filter(l => pattern.test(l)).join(' | ')

// 1. List: the empty case by identity, the other by `is` with its smart cast, in a `when` with no subject
const list = kotlin(readFileSync(join(TERM, 'bench/list/term.tree'), 'utf8'), 'list-runs', 'bench/list/term.tree')
ok('list: the empty case by identity', /\w+ === ChainEnd -> \{/.test(list) && !/is ChainEnd/.test(list), lines(list, /ChainEnd/))
ok('list: the other case keeps `is`', /\w+ is ChainLink -> \{/.test(list), lines(list, /ChainLink ->/))
ok('list: a `when` with no subject', /when \{/.test(list) && !/when \(\w+\) \{\n\s+\w+ ===/.test(list))

// 2. two forms naming a case alike: `none` has no fields in `flag` and a field in `slot`
const shared = kotlin(
  `form flag
  case none
  case some
    link value, like number

form slot
  case none
    link reason, like text
  case full
    link value, like number

task use
  take f, like flag
  take s, like slot
  like number
  fork case, read f
    case none
      send back, code 0
    case some
      send back, read value
  fork case, read s
    case none
      send back, code 1
    case full
      send back, read value
`,
  'use',
)
ok('the field-less `none` by identity', /f === (\w+\.)?FlagNone -> \{|f === None -> \{/.test(shared) || /f === \w*None\b/.test(shared), lines(shared, /f ===|f is/))
// a form with no field-less case keeps the `when (s)` it had, every arm by `is`
ok('the `none` with a field keeps `is`', /when \(s\) \{\n\s+is \w*None -> \{/.test(shared) && !/s === /.test(shared), lines(shared, /when \(s\)|is \w*None|s ===/))

console.log(`\nkotlin-identity: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
