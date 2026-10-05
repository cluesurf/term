// An element read is typed as the element (check/infer.ts, member with an index): `read xs/{i}` and `read xs/0` on a
// `list number` are numbers, `read table/{key}` on a `hash text number` is a number. They were `unknown` until
// 2026-10-02, so every backend treated them as a boxed dynamic: TypeScript compared one to `0` with the structural
// `__termEqual` and did not check arithmetic on it for overflow.
// Run: npx tsx test/check/element-read.ts

import { compile } from '@term/make/code/compile/compile'
import type { Program } from '@term/make/code/compile/node'

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

const text = `task first
  take xs, like list, like number
  take table, like hash, like text, like number
  take key, like text
  like number
  save i, code 0
  host a, read xs/{i}
  host b, read xs/0
  host c, read table/{key}
  send back
    call add
      read a
      call add
        read b
        read c
`

const built = compile({ file: 'main.tree', text }, { optimize: false })

if (!built.ok) {
  ok('the program builds', false, built.diagnostics.map(d => d.message).join(' | '))
} else {
  const lets = new Map<string, string | undefined>()
  const visit = (program: Program): void => {
    for (const node of program) {
      if (node.form === 'function') {
        for (const s of node.body) {
          if (s.form === 'let') {
            lets.set(s.name, s.init.type?.kind)
          }
        }
      }
    }
  }

  visit(built.program)
  ok('`read xs/{i}` on a list of numbers is a number', lets.get('a') === 'number', String(lets.get('a')))
  ok('`read xs/0` is a number', lets.get('b') === 'number', String(lets.get('b')))
  ok('`read table/{key}` on a hash of numbers is a number', lets.get('c') === 'number', String(lets.get('c')))
  ok('TypeScript declares the reads as numbers, not any', /const a: number = /.test(built.typescript) && !/const a: any/.test(built.typescript), built.typescript.split('\n').filter(l => /const [abc]:/.test(l)).join(' | '))
  // the check is `__termInt(...)` inside an expression, or tested where it stands when it is all a statement's value
  // (typescript.ts, `testedInPlace`)
  ok('and checks arithmetic on them for overflow', /__termInt\(|__termIntStop\(__n\d+\)/.test(built.typescript))
}

console.log(`\nelement-read: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
