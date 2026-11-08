// A Rust emitter shape the CLI's entry refused (finding/native-entry.md of term/self-host/change/001-finish-self-host,
// item term-self-host-001-1086, the rest of 1057), held through rustc and RUN, against TypeScript's answer: a closure
// whose sift arm binds a name by `link` (`case some` / `link key`, written `Maybe::Some { value: key }`) that the task
// declares too, later. The outer locals are every name the task declares, so the closure cloned `key` before the task
// had it (`let key = key.clone()`, E0425, at `owns-inner-item` and `enter-task`). Once directly in the closure's body,
// once inside a fork in it.
// Run: npx tsx test/compile/rust-closure-arm-link.ts

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

const text = `load @term/base/maybe
  find maybe

task half
  take i, like number
  like maybe number
  fork test, is-below(i, 5)
    hold
      back make some(add(i, 10))
  back make none

task pick
  take at, like number
  like number
  save chooser
    task
      take i, like number
      like number
      sift half(i)
        case some
          link key
          back key
        case none
          back 0
  save first, chooser(at)
  save key, add(first, 1)
  back key

task pick-deep
  take at, like number
  like number
  save chooser
    task
      take i, like number
      like number
      fork test, is-above(i, 0)
        hold
          sift half(i)
            case some
              link deep
              back deep
            case none
              save nothing, 0
      back 0
  save first, chooser(at)
  save deep, add(first, 2)
  back deep
`

// pick(3) is 14 and pick(9) is 1; pick-deep(2) is 14 and pick-deep(9) is 2
const want = '14|1|14|2'
const entries = ['pick', 'pick-deep']
const leanOf = (file: string): boolean => file.endsWith('arms.tree')

const node = compile(
  { file: '/gate/code/arms.tree', text },
  { resolve: withNativeEnv('node', stdlibResolver()!), leanOf, entryPoints: entries },
)

if (!node.ok) {
  ok('the program builds for node', false, node.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const dir = mkdtempSync(join(tmpdir(), 'term-rust-closure-arm-link-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(node.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as {
    pick: (n: number) => number
    pickDeep: (n: number) => number
  }
  const answer = `${mod.pick(3)}|${mod.pick(9)}|${mod.pickDeep(2)}|${mod.pickDeep(9)}`
  ok('TypeScript answers', answer === want, answer)
}

const built = compile(
  { file: '/gate/code/arms.tree', text },
  { resolve: withNativeEnv('rust', stdlibResolver()!), env: 'rust', leanOf, entryPoints: entries },
)

if (!built.ok) {
  ok('the program builds for rust', false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const emitted = emitRust(built.program)
  const early = emitted.split('\n').filter(line => /let (key|deep) = (key|deep)\.clone\(\)/.test(line))
  ok('the closure clones no name its arms bind', early.length === 0, early.join(' | '))

  const unwrapOf = (task: string): string =>
    new RegExp(`fn ${task}\\([^)]*\\) -> std::result::Result`).test(emitted) ? '.ok().unwrap()' : ''
  const rust = `${emitted}\nfn main() {\n    print!("{}|{}|{}|{}", pick(3)${unwrapOf('pick')}, pick(9)${unwrapOf('pick')}, pick_deep(2)${unwrapOf('pick_deep')}, pick_deep(9)${unwrapOf('pick_deep')});\n}\n`

  const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' })

  if (rustc.status !== 0) {
    console.log('skip  rustc  (not installed)')
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'term-rust-closure-arm-link-'))
    writeFileSync(join(dir, 'main.rs'), rust)
    const binary = join(dir, 'main')
    const out = spawnSync('rustc', ['--edition', '2021', '-A', 'warnings', '-o', binary, join(dir, 'main.rs')], {
      encoding: 'utf8',
    })
    const errors = out.stderr.split('\n').filter(l => /^error/.test(l))
    ok('rustc compiles it', out.status === 0, errors.join(' | '))
    ok('no name cloned before it is declared (E0425)', !errors.some(l => /E0425/.test(l)), errors.filter(l => /E0425/.test(l)).join(' | '))

    if (out.status === 0) {
      const ran = spawnSync(binary, [], { encoding: 'utf8' })
      ok('Rust answers what TypeScript does', ran.stdout.trim() === want, ran.stdout.trim())
    }
  }
}

console.log(`\nrust-closure-arm-link: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
