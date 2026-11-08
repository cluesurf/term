// Two Rust emitter shapes of the borrow phase the CLI's entry refused (finding/native-entry.md of
// term/self-host/change/001-finish-self-host, item term-self-host-001-1058), each its own program, held through rustc
// and RUN, against TypeScript's answer:
//   - copy-bind: a bind whose Rust text is its one parameter (`$value`, node-rebuild.tree's shallow copies) took a
//     variable bare, so `let mut copy = given;` moved it and the next read of `given` failed (E0382 borrow of moved
//     value, 21 sites in the rebuild ports). Once on a local, once on a parameter
//   - walk-item-write: a walk whose body writes a field of its item (`save field/value, ...`) bound the item with a
//     plain `let`, and the write failed (E0594 cannot assign to `field.value`, 21 sites in node-rewrite, check/extend).
//     Once over a list, once over a list of a record's field
// Run: npx tsx test/compile/rust-borrow-shapes.ts

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

const spot = `form spot
  link name, like text
  link size, like number
`

const copyBind = `${spot}
bind copy-spot
  take value, like spot
  like spot
  case node
    text <(\\{ ...$value \\})>
  case browser
    text <(\\{ ...$value \\})>
  case rust
    text <$value>
  case swift
    text <$value>
  case kotlin
    text <$value>

task grow-from
  take given, like spot
  like number
  save copy, copy-spot(given)
  save copy/size, add(given/size, 10)
  back add(copy/size, given/size)

task grow
  take at, like number
  like number
  back grow-from(make(spot, bind(name, <a>), bind(size, at)))

task grow-local
  take at, like number
  like number
  save given, make(spot, bind(name, <b>), bind(size, at))
  save copy, copy-spot(given)
  save copy/size, add(given/size, 20)
  back add(copy/size, given/size)
`

const walkWrite = `load @term/base/list
  find push

${spot}
form bag
  link name, like text
  link spots, like list, like spot

task total
  take at, like number
  like number
  save spots, make list
  push(spots, make(spot, bind(name, <a>), bind(size, at)))
  push(spots, make(spot, bind(name, <b>), bind(size, 2)))
  save out, make list
  walk spots
    take one
    save one/size, add(one/size, 1)
    push(out, one)
  save sum, 0
  walk out
    take one
    save sum, add(sum, one/size)
  back sum

task total-bag
  take at, like number
  like number
  save spots, make list
  push(spots, make(spot, bind(name, <a>), bind(size, at)))
  save held, make(bag, bind(name, <x>), bind(spots, spots))
  save out, make list
  walk held/spots
    take item
    save item/size, add(item/size, 5)
    push(out, item)
  save sum, 0
  walk out
    take item
    save sum, add(sum, item/size)
  back sum
`

interface Case {
  name: string
  text: string
  entries: string[]
  calls: [string, number][]
  want: string
  pattern: RegExp
  code: string
}

const cases: Case[] = [
  // grow(3) is (3 + 10) + 3; grow-local(4) is (4 + 20) + 4
  { name: 'copy-bind', text: copyBind, entries: ['grow', 'grow-local'], calls: [['grow', 3], ['grow_local', 4]], want: '16|28', pattern: /let mut copy = given;/, code: 'E0382' },
  // total(3) is 4 + 3; total-bag(1) is 6
  { name: 'walk-item-write', text: walkWrite, entries: ['total', 'total-bag'], calls: [['total', 3], ['total_bag', 1]], want: '7|6', pattern: /let (one|item) = [^;]*;[^\n]*\n[^\n]*(one|item)\.size = /, code: 'E0594' },
]

const camel = (snake: string): string => snake.replace(/_(\w)/g, (_, c: string) => c.toUpperCase())

for (const c of cases) {
  const file = `/gate/code/${c.name}.tree`
  const leanOf = (f: string): boolean => f === file
  const node = compile({ file, text: c.text }, { resolve: withNativeEnv('node', stdlibResolver()!), leanOf, entryPoints: c.entries })
  if (!node.ok) {
    ok(`${c.name}: the program builds for node`, false, node.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'term-rust-borrow-shapes-'))
    const out = join(dir, 'module.mjs')
    writeFileSync(out, transformSync(node.typescript, { loader: 'ts', format: 'esm' }).code)
    const mod = (await import(pathToFileURL(out).href)) as Record<string, (n: number) => number>
    const answer = c.calls.map(([task, n]) => mod[camel(task)]!(n)).join('|')
    ok(`${c.name}: TypeScript answers`, answer === c.want, answer)
  }

  const built = compile({ file, text: c.text }, { resolve: withNativeEnv('rust', stdlibResolver()!), env: 'rust', leanOf, entryPoints: c.entries })
  if (!built.ok) {
    ok(`${c.name}: the program builds for rust`, false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
    continue
  }
  const emitted = emitRust(built.program)
  ok(`${c.name}: the emitted shape is gone`, !c.pattern.test(emitted), (emitted.match(c.pattern) ?? [''])[0])
  const unwrapOf = (task: string): string => (new RegExp(`fn ${task}\\([^)]*\\) -> std::result::Result`).test(emitted) ? '.ok().unwrap()' : '')
  const prints = c.calls.map(([task, n]) => `${task}(${n})${unwrapOf(task)}`).join(', ')
  const rust = `${emitted}\nfn main() {\n    print!("${c.calls.map(() => '{}').join('|')}", ${prints});\n}\n`
  const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' })
  if (rustc.status !== 0) {
    console.log('skip  rustc  (not installed)')
    continue
  }
  const dir = mkdtempSync(join(tmpdir(), 'term-rust-borrow-shapes-'))
  writeFileSync(join(dir, 'main.rs'), rust)
  const binary = join(dir, 'main')
  const out = spawnSync('rustc', ['--edition', '2021', '-A', 'warnings', '-o', binary, join(dir, 'main.rs')], { encoding: 'utf8' })
  const errors = out.stderr.split('\n').filter(l => /^error/.test(l))
  ok(`${c.name}: rustc compiles it`, out.status === 0, errors.join(' | '))
  ok(`${c.name}: no ${c.code}`, !errors.some(l => l.includes(c.code)), errors.filter(l => l.includes(c.code)).join(' | '))
  if (out.status === 0) {
    const ran = spawnSync(binary, [], { encoding: 'utf8' })
    ok(`${c.name}: Rust answers what TypeScript does`, ran.stdout.trim() === c.want, ran.stdout.trim())
  }
}

console.log(`\nrust-borrow-shapes: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
