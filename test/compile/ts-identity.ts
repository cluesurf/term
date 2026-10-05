// TypeScript tests a field-less case by identity where every value of it is the one frozen constant (typescript.ts,
// `identityCases`), held both ways: List's empty list through a type guard, and a program that fills data into forms,
// one with a stub of another unit's task, and a module emitted alone each keep reading the tag. A wrong identity test
// is a wrong branch, so every refusal is a place a second object of the case could come from.
// Run: npx tsx test/compile/ts-identity.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'
import { identityCases } from '@term/make/code/compile/typescript'
import type { Program, Statement } from '@term/make/code/compile/node'

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
const built = (text: string, entry: string, file = 'main.tree'): { program: Program; typescript: string } => {
  const out = compile({ file, text }, { resolve: withNativeEnv('node', stdlibResolver()!), entryPoints: [entry] })

  if (!out.ok) {
    throw new Error(`${file}: ${out.diagnostics[0]?.message}`)
  }

  return { program: out.program, typescript: out.typescript }
}

// 1. List: the empty case by identity, through its guard
const list = built(readFileSync(join(TERM, 'bench/list/term.tree'), 'utf8'), 'list-runs', 'bench/list/term.tree')
ok('list: the empty case is an identity case', identityCases(list.program, false).has('chain/end'), [...identityCases(list.program, false)].join(', '))
ok('list: matches test it through its guard', /__termIsEnd\(\w+\)/.test(list.typescript) && !/\.form === "end"/.test(list.typescript))
ok('list: the guard narrows by the constant', /function __termIsEnd\(value: \{ form: string \}\): value is \{ form: "end" \} \{ return value === __termVariantEnd \}/.test(list.typescript))
ok('a module emitted alone keeps the tag', identityCases(list.program, true).size === 0)

// 2. what keeps reading the tag, each the list program but for one thing
const chain = `form chain
  case end
  case link
    link value, like number
    link next, like chain

task depth
  take c, like chain
  like number
  fork case, read c
    case end
      send back, code 0
    case link
      send back, code 1
`

const filled = built(
  `${chain}
task fill
  take x, like number
  like number
  send back, read x

task use
  take c, like chain
  like number
  send back
    call add
      call depth(read(c))
      call fill(code 1)
`,
  'use',
)
ok('a program that fills data keeps the tag', identityCases(filled.program, false).size === 0, [...identityCases(filled.program, false)].join(', '))

const stubbed = structuredClone(built(`${chain}\ntask use\n  take c, like chain\n  like number\n  send back, call depth(read(c))\n`, 'use').program)
const stub = stubbed.find((n): n is Extract<Statement, { form: 'function' }> => n.form === 'function' && n.name === 'depth')!
stub.stub = true
ok('a program holding a stub keeps the tag', identityCases(stubbed, false).size === 0)

console.log(`\nts-identity: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
