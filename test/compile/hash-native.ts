// term/hash.tree, the compiler's cache key, run natively. It did not build on Rust, Swift or Kotlin until 2026-10-04:
// its base-36 spelling was JavaScript's `value.toString(36)`, and it is now written out in Term. Two compilers that
// hash differently do not share a cache, so the Rust answer is held to the TypeScript one over texts that reach every
// part of it: empty, one character, astral characters, long runs, and values whose base-36 spelling starts with 0-9.
// Run: npx tsx test/compile/hash-native.ts

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { hashText } from '@term/make/code/term/hash'

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

const TEXTS = ['', 'a', 'task one', 'é', '中文', '𝔸😀', 'x'.repeat(5000), 'form a\n  link b, like text\n', '#\t<>{}']

// emitted through the built CLI, as `term make --emit rust` does, so the native prelude (`bit`) comes with it
const root = resolve(import.meta.dirname, '../../deck/make')
const emitted = spawnSync('node', ['../../host/line.js', 'make', '--emit', 'rust', 'code/term/hash.tree'], { cwd: root, encoding: 'utf8' })

if (emitted.status !== 0) {
  ok('the hash emits for rust', false, emitted.stderr.slice(0, 600))
} else {
  ok('the hash emits for rust', true)

  const main = `fn main() {\n${TEXTS.map(t => `    println!("{}", hash_text(${JSON.stringify(t)}.to_string()));`).join('\n')}\n}\n`
  const rust = `${emitted.stdout}\n${main}`

  const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' })

  if (rustc.status !== 0) {
    console.log('skip  rustc  (not installed)')
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'term-hash-native-'))
    writeFileSync(join(dir, 'main.rs'), rust)
    const binary = join(dir, 'main')
    const out = spawnSync('rustc', ['--edition', '2021', '-A', 'warnings', '-o', binary, join(dir, 'main.rs')], { encoding: 'utf8' })
    ok('rustc compiles it', out.status === 0, out.stderr.split('\n').filter(l => /^error/.test(l)).slice(0, 4).join(' | '))

    if (out.status === 0) {
      const lines = spawnSync(binary, [], { encoding: 'utf8' }).stdout.trim().split('\n')

      TEXTS.forEach((t, i) => {
        const want = hashText(t)
        ok(`Rust hashes ${JSON.stringify(t.length > 20 ? `${t.slice(0, 20)}...` : t)} as TypeScript does`, lines[i] === want, `rust ${lines[i]}, typescript ${want}`)
      })
    }
  }
}

console.log(`\nhash-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
