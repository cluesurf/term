// A bind whose Rust text ends in a cast, compared with `is-below`. The bind's text was spliced as written, so
// `is-below(char-count(scope), 2)` emitted `scope.chars().count() as i64 < 2` and rustc read the `<` as the start of
// `i64`'s generic arguments: a parse error, and the whole file refused. The CLI's entry met it at four sites
// (finding/native-entry.md of term/self-host/change/001-finish-self-host, item term-self-host-001-0797). A bind's text
// with a cast at its top level is now emitted in one pair. Held through rustc and RUN, against TypeScript's answer.
// Run: npx tsx test/compile/rust-cast-operand.ts

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

// the stdlib's char-count (a task over the code-point-count bind) and a bind of the program's own, each the left side
// of a less-than, the shape the CLI's entry refused
const text = `load @term/base/text
  find char-count

bind width-of
  take value, like text
  like number
  case node
    text <$value.length>
  case browser
    text <$value.length>
  case rust
    text <$value.len() as i64>
  case swift
    text <$value.utf8.count>
  case kotlin
    text <$value.length.toLong()>

task short
  take value, like text
  like number
  save answer, code 0
  fork test
    hook test
      call is-below
        call char-count
          read value
        code 2
    hook hold
      save answer, code 1
  send back, read answer

task narrow
  take value, like text
  like number
  save answer, code 0
  fork test
    hook test
      call is-below
        call width-of
          read value
        code 3
    hook hold
      save answer, code 1
  send back, read answer
`

const want = '1010'
const entries = ['short', 'narrow']

const node = compile(
  { file: 'cast.tree', text },
  { resolve: withNativeEnv('node', stdlibResolver()!), entryPoints: entries },
)

if (!node.ok) {
  ok('the program builds for node', false, node.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const dir = mkdtempSync(join(tmpdir(), 'term-rust-cast-operand-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(node.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as {
    short: (v: string) => number
    narrow: (v: string) => number
  }
  const answer = `${mod.short('a')}${mod.short('abc')}${mod.narrow('ab')}${mod.narrow('abcd')}`
  ok('TypeScript compares the counts', answer === want, answer)
}

const built = compile(
  { file: 'cast.tree', text },
  { resolve: withNativeEnv('rust', stdlibResolver()!), env: 'rust', entryPoints: entries },
)

if (!built.ok) {
  ok('the program builds for rust', false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const emitted = emitRust(built.program)
  // a text parameter is a `String` or a lent `&str`, as the emitter decides: the main passes what the signature asks
  const arg = (task: string, value: string): string =>
    new RegExp(`fn ${task}\\(\\w+: &str`).test(emitted) ? `"${value}"` : `"${value}".to_string()`
  const rust = `${emitted}\nfn main() {\n    print!("{}{}{}{}", short(${arg('short', 'a')}), short(${arg('short', 'abc')}), narrow(${arg('narrow', 'ab')}), narrow(${arg('narrow', 'abcd')}));\n}\n`
  const bare = rust.split('\n').filter(line => / as i64 </.test(line))
  ok('no cast is left bare before a less-than', bare.length === 0, bare.join(' | '))

  const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' })

  if (rustc.status !== 0) {
    console.log('skip  rustc  (not installed)')
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'term-rust-cast-operand-'))
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

console.log(`\nrust-cast-operand: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
