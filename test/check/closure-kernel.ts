// A pure task that answers a closure, saves one, or puts one in a record is checked by the kernel, which infers no bare
// function. The elaborator lowered every closure to a bare lambda, so such a task failed the build with "kernel:
// cannot infer a bare function" (local-store.tree's rooted-object-store, term-cli-in-term-0083), and builders gave the
// body a host call nothing read to keep it out of the kernel. A closure is now annotated with the pi type its written
// parameters and result give it (check/elaborating-terms.tree `closure-term`, term-compiler-0055).
//
// Run: npx tsx test/check/closure-kernel.ts

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

async function runOf(
  typescript: string,
): Promise<Record<string, () => unknown>> {
  const { transformSync } = await import('esbuild')
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const file = join(
    mkdtempSync(join(tmpdir(), 'term-closure-kernel-')),
    'module.mjs',
  )
  writeFileSync(
    file,
    transformSync(typescript, { loader: 'ts', format: 'esm' }).code,
  )

  return (await import(pathToFileURL(file).href)) as Record<
    string,
    () => unknown
  >
}

const CASES: { name: string; text: string; answer: unknown }[] = [
  {
    name: 'a closure over a parameter, saved and answered',
    text: `task make-adder\n  take n, like number\n  like task\n    take x, like number\n    like number\n  save adder\n    task\n      take x, like number\n      like number\n      send back\n        call add\n          read x\n          read n\n  send back, read adder\n\ntask run\n  like number\n  save f, call make-adder(code 2)\n  send back\n    call f\n      code 3\n`,
    answer: 5,
  },
  {
    name: 'a closure of no capture, saved and answered',
    text: `task make-one\n  like task\n    take x, like number\n    like number\n  save one\n    task\n      take x, like number\n      like number\n      send back, read x\n  send back, read one\n\ntask run\n  like number\n  save f, call make-one()\n  send back\n    call f\n      code 3\n`,
    answer: 3,
  },
  {
    name: 'a record of closures, as rooted-object-store makes',
    text: `form store\n  link has\n    like task\n      take x, like number\n      like boolean\n\ntask make-store\n  take n, like number\n  like store\n  save has-it\n    task\n      take x, like number\n      like boolean\n      send back\n        call is-above\n          read x\n          read n\n  send back\n    make store\n      bind has, read has-it\n\ntask run\n  like boolean\n  save s, call make-store(code 2)\n  send back\n    call s/has\n      code 3\n`,
    answer: true,
  },
  {
    name: 'a closure answered directly, checked against the result type',
    text: `task make-adder\n  take n, like number\n  like task\n    take x, like number\n    like number\n  send back\n    task\n      take x, like number\n      like number\n      send back\n        call add\n          read x\n          read n\n\ntask run\n  like number\n  save f, call make-adder(code 2)\n  send back\n    call f\n      code 3\n`,
    answer: 5,
  },
]

for (const one of CASES) {
  const result = compile(
    { file: 'main.tree', text: one.text },
    { resolve: () => undefined },
  )
  ok(
    one.name,
    result.ok,
    result.ok ? '' : result.diagnostics.map(d => d.message).join(' | '),
  )

  if (result.ok) {
    const mod = await runOf(result.typescript)
    ok(`  and it runs`, mod.run?.() === one.answer, String(mod.run?.()))
  }
}

console.log(`\nclosure-kernel: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
