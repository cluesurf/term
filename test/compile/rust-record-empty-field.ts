// A Rust emitter shape the CLI's entry refused (item term-self-host-001-1102 of term/self-host/change/001-finish-self-host,
// found by 1059): a construction that leaves out a `need false` field typed a RECORD form. The left-out field takes its
// type's empty value (item 1055), and compile/rust-tables empty-of answers `0` for any form name, so rustc refused
// `RunAsk { snapshots: 0 }`, `ChangedTask { async_: 0 }` and `HoldHit { report: 0 }` (E0308 expected `SnapshotAsk`,
// found integer). The empty value of a record is now its own construction with every field empty. Held through rustc
// and RUN, against TypeScript's answer: a plain record, a nested record (a record inside the left-out one, and a list),
// a union case, and a trailing `need false` parameter of a record type left out of a call. The left-out field is read
// nowhere: TypeScript holds it as undefined, Rust as the empty record.
// Run: npx tsx test/compile/rust-record-empty-field.ts

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

const text = `form mark
  link name, like text

form tally
  link seen, like boolean
  link count, like number
  link label, like text
  link marks, like list, like text
  link first, like mark

form shelf
  link name, like text
  link size, like number
  link tally
    like tally
    need false

form change
  case moved
    link size, like number
    link tally
      like tally
      need false
  case kept

task shelf-size
  take one, like shelf
  like number
  back add(one/size, 100)

task change-size
  take value, like change
  like number
  sift value
    case moved
      link size
      back size
    case kept
      back 0

task weigh
  take base, like number
  take extra
    like tally
    need false
  like number
  back add(base, 1)

task count
  take at, like number
  like number
  save one, make(shelf, bind(name, <a>), bind(size, at))
  save two, make(shelf, bind(name, <bb>), bind(size, 2), bind(tally, make(tally, bind(seen, true), bind(count, 1), bind(label, <x>), bind(marks, make(list)), bind(first, make(mark, bind(name, <m>))))))
  save three, make(moved, bind(size, 7))
  back add(add(shelf-size(one), two/size), add(change-size(three), weigh(at)))
`

// count(3) is 103 + 2 + 7 + 4 = 116 and count(10) is 110 + 2 + 7 + 11 = 130
const want = '116|130'
const entries = ['count']
const leanOf = (file: string): boolean => file.endsWith('shelves.tree')

const node = compile(
  { file: '/gate/code/shelves.tree', text },
  { resolve: withNativeEnv('node', stdlibResolver()!), leanOf, entryPoints: entries },
)

if (!node.ok) {
  ok('the program builds for node', false, node.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const dir = mkdtempSync(join(tmpdir(), 'term-rust-record-empty-field-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(node.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as { count: (n: number) => number }
  const answer = `${mod.count(3)}|${mod.count(10)}`
  ok('TypeScript answers', answer === want, answer)
}

const built = compile(
  { file: '/gate/code/shelves.tree', text },
  { resolve: withNativeEnv('rust', stdlibResolver()!), env: 'rust', leanOf, entryPoints: entries },
)

if (!built.ok) {
  ok('the program builds for rust', false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const emitted = built.program ? emitRust(built.program) : ''
  const bare = emitted.split('\n').filter(line => /\b(tally|extra): 0\b|weigh\([^)]*, 0\)/.test(line))
  ok('a left-out record field or argument is never a bare 0', bare.length === 0, bare.join(' | '))

  const unwrapOf = (task: string): string =>
    new RegExp(`fn ${task}\\([^)]*\\) -> std::result::Result`).test(emitted) ? '.ok().unwrap()' : ''
  const rust = `${emitted}\nfn main() {\n    print!("{}|{}", count(3)${unwrapOf('count')}, count(10)${unwrapOf('count')});\n}\n`

  const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' })

  if (rustc.status !== 0) {
    console.log('skip  rustc  (not installed)')
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'term-rust-record-empty-field-'))
    writeFileSync(join(dir, 'main.rs'), rust)
    const binary = join(dir, 'main')
    const out = spawnSync('rustc', ['--edition', '2021', '-A', 'warnings', '-o', binary, join(dir, 'main.rs')], {
      encoding: 'utf8',
    })
    const errors = out.stderr.split('\n').filter(l => /^error/.test(l))
    ok('rustc compiles it', out.status === 0, errors.join(' | '))
    ok('no integer where a record belongs (E0308)', !errors.some(l => /E0308/.test(l)), errors.filter(l => /E0308/.test(l)).join(' | '))

    if (out.status === 0) {
      const ran = spawnSync(binary, [], { encoding: 'utf8' })
      ok('Rust answers what TypeScript does', ran.stdout.trim() === want, ran.stdout.trim())
    }
  }
}

console.log(`\nrust-record-empty-field: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
