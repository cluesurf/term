// `halt <text>` raises an Error on TypeScript whether or not the text interpolates. An interpolated text is a
// `template` node, which the emitter's throw case missed, so `halt <cycle: {{x}}>` threw a bare STRING: no
// `message`, no stack, and `error instanceof Error` false in every handler. Found porting compile/affected,
// 2026-10-02. Run: npx tsx test/compile/halt-text.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from '@term/make/code/compile/compile'

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

const text = `task plain
  like text
  halt <it broke>

task interpolated
  take n, like number
  like text
  halt <it broke at {{n}}>
`

const out = compile({ file: '/gate/code/halt-text.tree', text })
ok('it compiles', out.ok, out.ok ? '' : out.diagnostics.map(d => d.message).join(' | '))

if (out.ok) {
  ok('an interpolated halt throws an Error', /throw new Error\(`it broke at \$\{n\}`\)/.test(out.typescript), out.typescript.slice(out.typescript.indexOf('function interpolated')))

  const dir = mkdtempSync(join(tmpdir(), 'term-halt-text-'))
  const file = join(dir, 'halt-text.ts')
  writeFileSync(file, out.typescript)
  const module = (await import(pathToFileURL(file).href)) as Record<string, (...args: unknown[]) => unknown>

  for (const [name, args, message] of [
    ['plain', [], 'it broke'],
    ['interpolated', [3], 'it broke at 3'],
  ] as const) {
    let caught: unknown

    try {
      module[name]!(...args)
    } catch (error) {
      caught = error
    }

    ok(`${name}: the raise is an Error`, caught instanceof Error, typeof caught)
    ok(`${name}: with the text as its message`, caught instanceof Error && caught.message === message, String(caught))
  }
}

console.log(`\nhalt-text: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
