// `digest-sha256-text` (@term/base/cryptography/digest, decision 080 of note/project/term/self-host/change/001-finish-
// self-host) on every backend: one program runs the FIPS 180-4 vectors (the empty message, "abc", the 448-bit two-block
// message, one million "a") plus U+00E9, U+1D11E and a lone surrogate through the env's synchronous fast path AND the
// Term reference (native/shared/cryptography/sha256), and both must print the vector's digest. TypeScript runs under
// the node env (node:crypto), Rust (sha2), Swift (CryptoKit) and Kotlin (MessageDigest) natively, and the BROWSER leg
// compiles the same program under the browser env, whose fast path IS the reference, and runs it under node.
//
// A lone surrogate is a UTF-16 unit, so only TypeScript and Kotlin can hold one: there it must encode as U+FFFD. On
// Rust and Swift `rune-to-text(55296)` is the empty text (no scalar), and the case reads "ab", which the program says.
// Skips a backend whose toolchain is absent. Run: npx tsx test/compile/digest-text-native.ts (DIGEST_ONLY=<backend>)

import {
  mkdtempSync,
  readFileSync,
  existsSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { nativeMain } from '@term/make/code/compile/native-main'
import { BACKENDS, runOn } from './shared/run-on'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

const FFFD =
  '05087813392efc16fe8ff448920c6328e53af865df39419436659d9ffda90f7b'
const AB =
  'fb8e20fc2e4c3f248c60c39bd652f3c1347298bb977b8b4d5903b85055620603'

// name, the program's expression for the text, and its digest
const VECTORS: [string, string, string][] = [
  [
    'empty',
    '<>',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  ],
  [
    'abc',
    '<abc>',
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  ],
  [
    'two-blocks',
    '<abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq>',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
  [
    'million-a',
    'repeat(<a>, 1000000)',
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
  ],
  [
    'e-acute',
    'rune-to-text(233)',
    '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c',
  ],
  [
    'g-clef',
    'rune-to-text(119070)',
    'e419efd3d6046adf7662b0daadab65047e8014a523316d7ccc8710de694aa9b6',
  ],
  ['replacement', '<a{rune-to-text(65533)}b>', FFFD],
  ['lone-surrogate', '<a{rune-to-text(55296)}b>', FFFD],
]

const PROGRAM = `load @term/base/native/shared/cryptography/sha256
  find calculate-sha256-text

load @term/base/cryptography/digest
  find digest-sha256-text

load @term/base/text/string
  find repeat

load @term/base/text/unicode
  find rune-to-text

load @term/base/text
  find char-count

load @term/base/list
  find join

task both
  take value, like text
  like text
  save fast, call(digest-sha256-text, read(value))
  save reference, call(calculate-sha256-text, read(value))
  send back, text <{fast} {reference} {char-count(value)}>

task run
  like text
  save lines, make list
${VECTORS.map(([, expression]) => `  call lines/push(call(both, ${expression.startsWith('<') ? `text ${expression}` : expression}))`).join('\n')}
  send back, call(join, read(lines), text <;>)
`

// a backend's answer, each vector's fast and reference digests checked against the vector
function judge(backend: string, output: string): void {
  const lines = output.trim().split(';')
  ok(
    `${backend}: one answer per vector`,
    lines.length === VECTORS.length,
    JSON.stringify(output.slice(0, 400)),
  )

  VECTORS.forEach(([name, , want], at) => {
    const [fast, reference, count] = (lines[at] ?? '').split(' ')
    // Rust and Swift hold no lone surrogate: the text is "ab", two characters, and that is what both paths digest
    const holdsNone = name === 'lone-surrogate' && count === '2'
    const expect = holdsNone ? AB : want
    ok(
      `${backend}: ${name} fast path${holdsNone ? ' (no lone surrogate on this backend: "ab")' : ''}`,
      fast === expect,
      `got ${fast}`,
    )
    ok(
      `${backend}: ${name} Term reference`,
      reference === expect,
      `got ${reference}`,
    )
  })
}

const dir = mkdtempSync(join(tmpdir(), 'term-digest-text-'))
const only = process.env.DIGEST_ONLY ?? ''

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({
    backend,
    program: PROGRAM,
    resolve: env => projectResolver(process.cwd(), env),
    dir,
    name: 'digest-text',
  })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  if (ran.form !== 'ran') {
    ok(
      `${backend}: builds and runs`,
      false,
      `${ran.stage}: ${ran.reason}`,
    )
    continue
  }

  judge(backend, ran.output)
}

// the browser leg: the same program under the browser env, where `digest-sha256-text` is the Term reference, run
// under node (it reaches no browser API)
if (!only || only === 'browser') {
  const source = join(dir, 'digest-text-browser.tree')
  writeFileSync(source, PROGRAM)
  const result = compile(
    { file: source, text: PROGRAM },
    {
      resolve: projectResolver(process.cwd(), 'browser'),
      env: 'browser',
    },
  )

  if (!result.ok) {
    ok(
      'browser: compiles',
      false,
      [...new Set(result.diagnostics.map(d => d.message))]
        .slice(0, 6)
        .join(' | '),
    )
  } else {
    ok(
      'browser: the fast path is the Term reference (no crypto runtime call for it)',
      !/createHash|crypto\.subtle/.test(result.typescript),
    )
    const prelude = nativePrelude(
      result.program,
      'browser',
      file =>
        existsSync(file) ? readFileSync(file, 'utf8') : undefined,
      result.typescript,
    )
    const file = join(dir, 'digest-text-browser.ts')
    writeFileSync(
      file,
      `${prelude}\n${result.typescript}\n${nativeMain('node', result.typescript)}\n`,
    )
    const run = spawnSync(process.execPath, ['--import', 'tsx', file], {
      encoding: 'utf8',
    })

    if (run.status !== 0) {
      ok('browser: runs', false, String(run.stderr).slice(0, 800))
    } else {
      judge('browser', String(run.stdout))
    }
  }
}

console.log(`\ndigest-text-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
