// Which programs' text-keyed maps hold their keys as a `TermKey` on Rust (rust.ts, `textKeysOf`, codegen-performance-0036),
// held both ways. A `TermKey` is not a `String`, so a program where a key can be seen as a value again keeps `String`
// keys: a wrong `TermKey` is a Rust type error, and a wrong `String` only an allocation per key. The meaning fixture
// `text-keys` holds the answers on four backends.
// Run: npx tsx test/compile/rust-text-keys.ts

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'
import { emitRust, textKeyReason } from '@term/make/code/compile/rust'
import type { Program } from '@term/make/code/compile/node'

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

const TERM = join(import.meta.dirname, '../..')
const stdlib = stdlibResolver()!
const build = (text: string, entry = 'use', file = 'main.tree'): Program => {
  const built = compile({ file, text }, { resolve: withNativeEnv('rust', stdlib), env: 'rust', entryPoints: [entry] })

  if (!built.ok) {
    throw new Error(`${file}: ${built.diagnostics[0]?.message}`)
  }

  return built.program
}

// 1. k-nucleotide: counted, sized, its values read, one key looked up: every key a `TermKey`
const knuc = build(readFileSync(join(TERM, 'mark/k-nucleotide/term.tree'), 'utf8'), 'k-nucleotide', 'mark/k-nucleotide/term.tree')
const knucRust = emitRust(knuc)
ok('k-nucleotide takes TermKey', textKeyReason(knuc) === undefined, textKeyReason(knuc))
ok('its map is TermMap<TermKey, i64>', /TermMap<TermKey, i64>/.test(knucRust) && !/TermMap<String, i64>/.test(knucRust))
ok('a key looked up through a generic task is made one', /hash_get_or_default\([^;]*TermKey::from\("ggt"\), 0\)/.test(knucRust), knucRust.split('\n').filter(l => /ggt/.test(l)).join(' | '))
ok('the count still borrows its key', /upsert_ref\(key, 0\)/.test(knucRust))

// a map counted from a word, answering what `result` declares
const counting = (result: string): string => `load @term/base/hash
  find hash

task use
  take word, like text
${result}
  save counts
    make hash
  call set
    read counts
    read word
    code 1
`

// 2. what must keep String keys, each the counting program but for one thing
const refuses = (label: string, text: string, why: RegExp): void => {
  const program = build(text)
  const reason = textKeyReason(program)
  ok(`keeps String: ${label}`, reason !== undefined && why.test(reason) && !/TermMap<TermKey|TermKey::from|enum TermKey/.test(emitRust(program)), reason)
}

ok('the counting program alone takes TermKey', textKeyReason(build(`${counting('  like number')}  send back, call size(read(counts))\n`)) === undefined)

refuses('its keys read back', `${counting('  like list, like text')}  send back, call keys(read(counts))\n`, /keys answers or calls back with a key/)
refuses('its entries read back', `${counting('  like list')}  send back, call entries(read(counts))\n`, /entries answers or calls back with a key/)
refuses(
  'a map handed where unknown is declared',
  `${counting('  like number')}  send back, call measure(read(counts))

task measure
  take value, like unknown
  like number
  send back, code 1
`,
  /a map handed to measure/,
)
refuses('no map keyed by text', `task use\n  take word, like text\n  like number\n  send back, code 1\n`, /no map keyed by text/)

// a real `call fill / ... / like <form>` reaches the backends as a call to `fill-form`: the counting program with its
// `size` call given that name, the shape alone being what the refusal reads
{
  const program = structuredClone(build(`${counting('  like number')}  send back, call size(read(counts))\n`))
  const rename = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return
    if (Array.isArray(value)) return value.forEach(rename)
    const node = value as { form?: string; callee?: { form?: string; name?: string } }
    if (node.form === 'call' && node.callee?.form === 'variable' && /size/.test(node.callee.name ?? '')) node.callee.name = 'fill-form'
    Object.values(node).forEach(rename)
  }
  rename(program)
  ok('keeps String: a call to fill-form', /a call to fill-form/.test(textKeyReason(program) ?? ''), textKeyReason(program))
}

// 3. a key that is an OWNED String: one built by formatting, and one counted. The emitter wrote `TermKey::from(&(..))`,
// a `&String` with no `From` (`From<&str>` only), and `upsert_ref(&w, 0)`, whose generic borrow then inferred `String`,
// which a `TermKey` cannot lend. Both were `rustc` errors in the ir/net and ir/perceus ports (self-hosting, 2026-10-04).
// Compiled with rustc here, since a pattern over the text cannot see a type error
{
  const owned = build(`load @term/base/hash
  find hash

load @term/base/list
  find list

task use
  take a, like number
  take b, like number
  like number
  save counts
    make hash
  call set
    read counts
    text <{a}:{b}>
    code 1
  save words, make list
  call words/push, text <x>
  walk words
    take w
    call set
      read counts
      read w
      call add
        call get-or-default
          read counts
          read w
          code 0
        code 1
  send back, call size(read(counts))
`)
  const rust = emitRust(owned)
  ok('the owned-key program takes TermKey', /TermMap<TermKey, i64>/.test(rust), textKeyReason(owned))

  const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' })

  if (rustc.status !== 0) {
    console.log('skip  rustc on the owned-key program  (rustc not installed)')
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'term-text-keys-'))
    writeFileSync(join(dir, 'owned.rs'), rust)
    const built = spawnSync('rustc', ['--edition', '2021', '--crate-type', 'lib', '-A', 'warnings', '-o', join(dir, 'libowned.rlib'), join(dir, 'owned.rs')], { encoding: 'utf8' })
    ok('rustc compiles a formatted key and a counted owned key', built.status === 0, built.stderr.split('\n').filter(l => /^error/.test(l)).join(' | '))
  }
}

console.log(`\nrust-text-keys: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
