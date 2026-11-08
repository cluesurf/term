// A Rust emitter shape the CLI's entry refused (finding/native-entry.md of term/self-host/change/001-finish-self-host,
// item term-self-host-001-1056), held through rustc and RUN, against TypeScript's answer: a construction that leaves out
// an optional field typed `dynamic`. The left-out field takes its type's empty value (item 1055), and compile/rust-tables
// empty-of had no `dynamic` case, so it wrote `0` where the field is the boxed dynamic `Rc<dyn Any>` (E0308 expected
// `Rc<dyn Any>`, found integer: `ItemAsk { duration: 0 }`, `KeeperItem { kind: 0, facts: 0 }`, 243 sites). A field typed
// `unknown` beside it, the same slot, is the control. Built directly, given to a task, and with the dynamic field given.
// Run: npx tsx test/compile/rust-dynamic-empty-field.ts

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { emitRust } from '@term/make/code/compile/rust'
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

const text = `form item
  link name, like text
  link size, like number
  link wait
    like dynamic
    need false
  link rest
    like unknown
    need false
  link tag
    like text
    need false

task measure
  take one, like item
  like number
  back add(one/size, 100)

task count
  take at, like number
  like number
  save one, make(item, bind(name, <a>), bind(size, at))
  save two, make(item, bind(name, <bb>), bind(size, 2), bind(wait, 7))
  back add(one/size, two/size)

task weigh
  take at, like number
  like number
  back measure(make(item, bind(name, <c>), bind(size, at)))
`

// count(3) is 5 and count(10) is 12; weigh(4) is 104
const want = '5|12|104'
const entries = ['count', 'weigh']
const leanOf = (file: string): boolean => file.endsWith('items.tree')

const node = compile(
  { file: '/gate/code/items.tree', text },
  { resolve: withNativeEnv('node', stdlibResolver()!), leanOf, entryPoints: entries },
)

if (!node.ok) {
  ok('the program builds for node', false, node.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const dir = mkdtempSync(join(tmpdir(), 'term-rust-dynamic-empty-field-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(node.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as {
    count: (n: number) => number
    weigh: (n: number) => number
  }
  const answer = `${mod.count(3)}|${mod.count(10)}|${mod.weigh(4)}`
  ok('TypeScript answers', answer === want, answer)
}

const built = compile(
  { file: '/gate/code/items.tree', text },
  { resolve: withNativeEnv('rust', stdlibResolver()!), env: 'rust', leanOf, entryPoints: entries },
)

if (!built.ok) {
  ok('the program builds for rust', false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const emitted = emitRust(built.program)
  const bare = emitted.split('\n').filter(line => /\b(wait|rest): 0\b/.test(line))
  ok('a left-out dynamic or unknown field is never a bare 0', bare.length === 0, bare.join(' | '))

  const unwrapOf = (task: string): string =>
    new RegExp(`fn ${task}\\([^)]*\\) -> std::result::Result`).test(emitted) ? '.ok().unwrap()' : ''
  const rust = `${emitted}\nfn main() {\n    print!("{}|{}|{}", count(3)${unwrapOf('count')}, count(10)${unwrapOf('count')}, weigh(4)${unwrapOf('weigh')});\n}\n`

  const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' })

  if (rustc.status !== 0) {
    console.log('skip  rustc  (not installed)')
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'term-rust-dynamic-empty-field-'))
    writeFileSync(join(dir, 'main.rs'), rust)
    const binary = join(dir, 'main')
    const out = spawnSync('rustc', ['--edition', '2021', '-A', 'warnings', '-o', binary, join(dir, 'main.rs')], {
      encoding: 'utf8',
    })
    const errors = out.stderr.split('\n').filter(l => /^error/.test(l))
    ok('rustc compiles it', out.status === 0, errors.join(' | '))
    ok('no integer where the boxed dynamic belongs (E0308)', !errors.some(l => /E0308/.test(l)), errors.filter(l => /E0308/.test(l)).join(' | '))

    if (out.status === 0) {
      const ran = spawnSync(binary, [], { encoding: 'utf8' })
      ok('Rust answers what TypeScript does', ran.stdout.trim() === want, ran.stdout.trim())
    }
  }
}

console.log(`\nrust-dynamic-empty-field: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
