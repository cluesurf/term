// A `void` argument to a dock call, and a unit value answered. The emitter strips a balanced outer pair of
// parentheses off a value as the binary case's grouping, and the unit value `()` is such a pair: stripped, the
// argument was written as nothing, `JSON::stringify(roll.clone(), , 2)`, a parse error that refused the whole file.
// The CLI's entry met it at two sites (write-watch-roll in deck/call/code/work/build/tree-watching.tree and its twin in
// build-command.tree, finding/native-entry.md of term/self-host/change/001-finish-self-host, item
// term-self-host-001-1053). TypeScript writes `undefined`. Held through rustc and RUN, against TypeScript's answer.
// Run: npx tsx test/compile/rust-void-argument.ts

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

// the shape the CLI's entry wrote, lean: a dock call with `void` in the middle of its arguments
const text = `dock load
  load <global:probe>, name probe-host

task show
  take n, like number
  like text
  back probe-host/shown(n, void, 2)

task check
  take n, like number
  like void
  fork test, is-below(n, 0)
    hold
      back void
  probe-host/shown(n, void, 2)
`

const want = '5|void|2'
const entries = ['show', 'check']

const node = compile(
  { file: '/gate/code/void.tree', text },
  { resolve: withNativeEnv('node', stdlibResolver()!), leanOf: () => true, entryPoints: entries },
)

if (!node.ok) {
  ok('the program builds for node', false, node.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  ;(globalThis as Record<string, unknown>).probe = {
    shown: (n: number, r: unknown, k: number) => `${n}|${r === undefined ? 'void' : 'value'}|${k}`,
  }
  const dir = mkdtempSync(join(tmpdir(), 'term-rust-void-argument-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(node.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as { show: (n: number) => string; check: (n: number) => void }
  mod.check(-1)
  mod.check(1)
  const answer = mod.show(5)
  ok('TypeScript passes the void', answer === want, answer)
}

const built = compile(
  { file: '/gate/code/void.tree', text },
  { resolve: withNativeEnv('rust', stdlibResolver()!), env: 'rust', leanOf: () => true, entryPoints: entries },
)

if (!built.ok) {
  ok('the program builds for rust', false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const emitted = emitRust(built.program)
  const empty = emitted.split('\n').filter(line => /\(\s*,|,\s*,|,\s*\)/.test(line) && /probe_host::/.test(line))
  ok('no argument is written as nothing', empty.length === 0, empty.join(' | '))
  // `back void` in a task that can raise: the unit answer was stripped the same way, `Ok()` (E0061)
  const bareOk = emitted.split('\n').filter(line => /Ok\(\)/.test(line))
  ok('a unit answer is written Ok(())', bareOk.length === 0, bareOk.join(' | '))

  // the dock's module, as a crate or a runtime file would hold it: the unit is Rust's void
  const host = `mod probe_host {\n    pub fn shown(n: i64, r: (), k: i64) -> String { format!("{}|{}|{}", n, if r == () { "void" } else { "value" }, k) }\n}\n`
  const unwrap = /fn show\([^)]*\) -> std::result::Result/.test(emitted) ? '.ok().unwrap()' : ''
  const checked = /fn check\([^)]*\) -> std::result::Result/.test(emitted) ? '.ok().unwrap()' : ''
  const rust = `${emitted}\n${host}\nfn main() {\n    check(-1)${checked};\n    check(1)${checked};\n    print!("{}", show(5)${unwrap});\n}\n`

  const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' })

  if (rustc.status !== 0) {
    console.log('skip  rustc  (not installed)')
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'term-rust-void-argument-'))
    writeFileSync(join(dir, 'main.rs'), rust)
    const binary = join(dir, 'main')
    const out = spawnSync('rustc', ['--edition', '2021', '-A', 'warnings', '-o', binary, join(dir, 'main.rs')], {
      encoding: 'utf8',
    })
    ok(
      'rustc compiles it',
      out.status === 0,
      out.stderr
        .split('\n')
        .filter(l => /^error/.test(l))
        .join(' | '),
    )

    if (out.status === 0) {
      const ran = spawnSync(binary, [], { encoding: 'utf8' })
      ok('Rust answers what TypeScript does', ran.stdout.trim() === want, ran.stdout.trim())
    }
  }
}

console.log(`\nrust-void-argument: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
