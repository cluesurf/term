// Rust emitter shapes the CLI's entry refused after 1058 (finding/native-entry.md of
// term/self-host/change/001-finish-self-host, item term-self-host-001-1094), each its own program, held through rustc
// and RUN, against TypeScript's answer:
//   - key-moved: a computed key (`save seen/{name}, ...`) was no read of `name` to the move scan (rust-names.tree
//     move-on-last-use), so a name read once besides its keys moved there and the key after failed (E0382 use of moved
//     value `name`, `task_name`, 11 sites in scan_pure, bind_capture, count_name)
//   - arm-local-write: a sift arm's link the arm writes (`save component/props, ...`) was bound plain (E0594 cannot
//     assign to `component.props`, node-rewrite.tree and disambiguate.tree)
//   - float-slot: a whole number into a `float` field or parameter, or beside a float in arithmetic or a comparison,
//     stayed an integer (E0308 expected `f64`, found integer, 36 sites, knit/spend.tree; E0277 `f64 + {integer}`)
//   - shared-dynamic-write: a field of a `mark shared` form typed `dynamic` written with a concrete value took it
//     unboxed (E0308 expected `Rc<dyn Any>`, found `DevServer`)
// Run: npx tsx test/compile/rust-slot-shapes.ts

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

const keyMoved = `load @term/base/list
  find push

task note-name
  take names, like list, like text
  take seen, like hash, like text, like number
  take name, like text
  push(names, name)
  save seen/{name}, names/length

task note-twice
  take seen, like hash, like text, like number
  take name, like text
  save seen/{name}, 1
  save seen/{name}, 2

task count-names
  take at, like number
  like number
  save names, make list
  save seen, make hash
  note-name(names, seen, <a>)
  note-name(names, seen, <bb>)
  note-twice(seen, <c>)
  back add(names/length, at)
`

const armLocalWrite = `load @term/base/maybe
  find maybe

form spot
  link name, like text
  link size, like number

form bag
  link name, like text
  link spot, like maybe, like spot

task grow-bag
  take one, like bag
  like number
  save held, one
  sift held/spot
    case some
      link found
      save found/size, add(found/size, 5)
      save held/spot, make(some, found)
    case none
      save nothing, 0
  sift held/spot
    case some
      link found
      back found/size
    case none
      back 0

task grow
  take at, like number
  like number
  back grow-bag(make(bag, bind(name, <b>), bind(spot, make(some, make(spot, bind(name, <s>), bind(size, at))))))
`

const floatSlot = `form price
  link input, like float
  link output, like float

task scale
  take x, like float
  take by, like number
  like float
  save y, add(x, by)
  fork test, is-above(y, 100)
    hold
      back 100
  back y

task priced
  take at, like number
  like float
  save p, make(price, bind(input, 4), bind(output, at))
  fork test, is-equal(p/input, 4)
    hold
      back add(add(p/input, p/output), scale(2, at))
  back add(p/input, 1)
`

const sharedDynamicWrite = `form spot
  link name, like text
  link size, like number

form holder
  mark shared
  link name, like text
  link held, like dynamic

task hold-spot
  take at, like number
  like number
  save h, make(holder, bind(name, <h>), bind(held, 0))
  save h/held, make(spot, bind(name, <s>), bind(size, at))
  back add(at, 1)
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
  // count-names(3) is 2 + 3
  { name: 'key-moved', text: keyMoved, entries: ['count-names'], calls: [['count_names', 3]], want: '5', pattern: /list_push\([^;]*, name\);/, code: 'E0382' },
  // grow(3) is 3 + 5
  { name: 'arm-local-write', text: armLocalWrite, entries: ['grow'], calls: [['grow', 3]], want: '8', pattern: /value: found \} => \{\n[^\n]*found\.size = /, code: 'E0594' },
  // priced(3) is (4 + 3) + (2 + 3)
  { name: 'float-slot', text: floatSlot, entries: ['priced'], calls: [['priced', 3]], want: '12', pattern: /input: 4\b/, code: 'E0308' },
  // hold-spot(3) is 4
  { name: 'shared-dynamic-write', text: sharedDynamicWrite, entries: ['hold-spot'], calls: [['hold_spot', 3]], want: '4', pattern: /let __shared_value = Spot \{/, code: 'E0308' },
]

const camel = (snake: string): string => snake.replace(/_(\w)/g, (_, c: string) => c.toUpperCase())

for (const c of cases) {
  const file = `/gate/code/${c.name}.tree`
  const leanOf = (f: string): boolean => f === file
  const node = compile({ file, text: c.text }, { resolve: withNativeEnv('node', stdlibResolver()!), leanOf, entryPoints: c.entries })
  if (!node.ok) {
    ok(`${c.name}: the program builds for node`, false, node.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'term-rust-slot-shapes-'))
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
  const dir = mkdtempSync(join(tmpdir(), 'term-rust-slot-shapes-'))
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

console.log(`\nrust-slot-shapes: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
