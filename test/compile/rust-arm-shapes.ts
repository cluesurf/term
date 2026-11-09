// Rust emitter shapes of the type phase the CLI's entry refused (finding/native-entry.md of
// term/self-host/change/001-finish-self-host, item term-self-host-001-1059), each its own program, held through rustc
// and RUN, against TypeScript's answer:
//   - shared-label-arm-write: a sift arm that writes a field of its subject (`save one/size, ...`) is written through the
//     subject's own case (decision 115 section 3) only when the arm's case label names that field. The fields were
//     looked up by the bare label, so where another form has a case of the same name without that field (`box` below,
//     node.tree's `float`, `array`, `let`, `expression`), the write fell through to `one.size = ...` on the enum
//     (E0609 no field on type `Expression`, `Statement`, `Type`, `ViewNode`, `Node`, `TemplatePart`, 115 sites)
// Run: npx tsx test/compile/rust-arm-shapes.ts

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

// `box` is a case of both forms; `mark`'s, written last, has no `size`
const sharedLabel = `form shape
  case box
    link size, like number
    link name, like text
  case dot
    link size, like number

form mark
  case box
    link name, like text
  case line
    link name, like text

task grow-shape
  take one, like shape
  like shape
  sift one
    case box
      save one/size, add(one/size, 10)
    case dot
      save one/size, add(one/size, 1)
  back one

task size-of
  take one, like shape
  like number
  sift one
    case box
      back one/size
    case dot
      back one/size

task grow
  take at, like number
  like number
  save a, grow-shape(make(box, bind(size, at), bind(name, <a>)))
  save b, grow-shape(make(dot, bind(size, at)))
  back add(size-of(a), size-of(b))
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
  // grow(3) is (3 + 10) + (3 + 1)
  { name: 'shared-label-arm-write', text: sharedLabel, entries: ['grow'], calls: [['grow', 3]], want: '17', pattern: /\bone\.size = /, code: 'E0609' },
]

const camel = (snake: string): string => snake.replace(/_(\w)/g, (_, c: string) => c.toUpperCase())

for (const c of cases) {
  const file = `/gate/code/${c.name}.tree`
  const leanOf = (f: string): boolean => f === file
  const node = compile({ file, text: c.text }, { resolve: withNativeEnv('node', stdlibResolver()!), leanOf, entryPoints: c.entries })
  if (!node.ok) {
    ok(`${c.name}: the program builds for node`, false, node.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'term-rust-arm-shapes-'))
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
  const dir = mkdtempSync(join(tmpdir(), 'term-rust-arm-shapes-'))
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

console.log(`\nrust-arm-shapes: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
