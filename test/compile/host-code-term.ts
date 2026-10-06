// tree/code in Term (`@term/host` code.tree) against the compiler's reference codec (compile/host-code.ts): the same
// value gives the same bytes from both, each reads the other's bytes back to the same value, and a stream that is not
// canonical tree/code is refused by both with the same name. The reference is the oracle. Compiles a probe entry that
// links the stdlib and the package, runs the emitted module. Run: npx tsx test/compile/host-code-term.ts

import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
import { projectDeckOf } from '@term/call/code/deck-of'
import { nativePrelude, withNativeEnv } from '@term/make/code/compile/native'
import type { Data } from '@term/make/code/compile/host'
import { expandData, readDataText, writeLong } from '@term/make/code/compile/host'
import { decodeTree, encodeTree } from '@term/make/code/compile/host-code'

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

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const FIXTURE = join(TERM, 'deck/host/test/fixture')

const ENTRY = `load @term/host/code/base
  find data
  find read
  find write
  find to-code
  find to-code-all
  find from-code

# the tree/code of a data file's text
task code-of
  take input, like text
  like bytes
  send back
    call to-code
      call read
        read input

# the long form of the first value of a tree/code stream
task long-of-code
  take input, like bytes
  like text
  save values
    call from-code
      read input
  send back
    call write
      read values/0

# a stream decoded and encoded again
task recode
  take input, like bytes
  like bytes
  save values
    call from-code
      read input
  send back
    call to-code-all
      read values
`

function hex(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join(' ')
}

function bytes(text: string): Uint8Array {
  return Uint8Array.from(text.split(/\s+/).filter(Boolean).map(b => Number.parseInt(b, 16)))
}

// the value a data file's text reads to, as the reference reads it
function oracle(text: string): Data {
  const read = readDataText({ file: 'x.tree', text })

  if (!read.ok) {
    throw new Error(`${read.diagnostics.map(d => d.message).join(' | ')}, reading ${JSON.stringify(text)}`)
  }

  const expanded = expandData(read.data, 'x.tree')

  if (!expanded.ok) {
    throw new Error(expanded.diagnostics.map(d => d.message).join(' | '))
  }

  return expanded.data
}

function generator(seed: number): () => number {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = ['name', 'age', 'active', '', 'é', '世界', '😀', 'x-y', '<>{}', 'line\nbreak', 'tab\there']
const KEYS = ['name', 'age', 'active', 'tags', 'id', 'kind', 'size', 'note']

// values a data file can hold, kept inside what Term carries: integers in the signed 64-bit range
function generated(random: () => number, depth: number): Data {
  const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)] as T
  const roll = random()

  if (depth > 0 && roll < 0.15) {
    return { kind: 'list', list: Array.from({ length: Math.floor(random() * 6) }, () => generated(random, depth - 1)) }
  }

  if (depth > 0 && roll < 0.3) {
    return { kind: 'hash', list: KEYS.filter(() => random() < 0.5).map(name => ({ name, base: generated(random, depth - 1) })) }
  }

  switch (Math.floor(random() * 7)) {
    case 0:
      return { kind: 'number', value: Math.floor((random() - 0.5) * 2 ** Math.floor(random() * 50)) }
    case 1:
      return { kind: 'number', value: pick([0, 1, 27, 28, -1, -28, -29, 255, 4096, -100000, 2 ** 40]) }
    case 2:
      return { kind: 'decimal', value: pick([0.5, 0.1, -2.75, 1e300, -1e-300, 3.25, 123456.789, 2.0, -7.0, 1.5e20]) }
    case 3:
      return { kind: 'decimal', value: (random() - 0.5) * 10 ** Math.floor(random() * 12) }
    case 4:
      return { kind: 'text', value: pick(WORDS) }
    case 5:
      return { kind: 'flag', value: random() < 0.5 }
    default:
      return { kind: 'void' }
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'term-host-code-'))
  mkdirSync(join(root, 'link/@term'), { recursive: true })
  mkdirSync(join(root, 'code'), { recursive: true })
  symlinkSync(join(TERM, 'deck/base'), join(root, 'link/@term/base'))
  symlinkSync(join(TERM, 'deck/host'), join(root, 'link/@term/host'))
  writeFileSync(join(root, 'deck.tree'), 'deck @probe/host-code\n  code <0.0.0>\n')
  const entry = join(root, 'code/data.tree')
  writeFileSync(entry, ENTRY)

  const result = compile({ file: entry, text: ENTRY }, { resolve: withNativeEnv('node', projectResolver(root)), deckOf: projectDeckOf() })

  ok('the package compiles with the codec', result.ok, result.ok ? '' : result.diagnostics.map(d => `${d.file?.split('/').pop()}: ${d.message}`).join(' | '))

  if (!result.ok) {
    console.log(`\nhost-code-term: ${pass} pass, ${fail} fail`)
    process.exit(1)
  }

  const prelude = nativePrelude(result.program, 'node', p => (existsSync(p) ? readFileSync(p, 'utf8') : undefined))
  const out = join(root, 'data.mjs')

  writeFileSync(join(root, 'host-code-emit.ts'), result.typescript)
  writeFileSync(out, transformSync(prelude + '\n' + result.typescript, { loader: 'ts', format: 'esm' }).code)

  const mod = await import(pathToFileURL(out).href)

  // the problem a stream is refused with, by Term
  const refusal = (stream: Uint8Array): string => {
    try {
      mod.recode(stream)

      return 'accepted'
    } catch (error) {
      return (error as { link?: { problem?: string } }).link?.problem ?? String(error)
    }
  }

  // ---- the worked example of 10-code.md ----

  const example = 'list member\n  mesh\n    host name, <ada>\n    host age, 36\n    host active, true\n  mesh\n    host name, <alan>\n    host age, 41\n    host active, false\n'
  const spec = 'd3 54 52 01 01 2a a1 46 6d 65 6d 62 65 72 82 a3 44 6e 61 6d 65 43 61 67 65 46 61 63 74 69 76 65 43 61 64 61 1c 08 e1 c1 44 61 6c 61 6e 1c 0d e0'

  ok('Term writes the worked example byte for byte', hex(mod.codeOf(example)) === spec, hex(mod.codeOf(example)))

  // ---- fixtures, both ways ----

  for (const name of ['basic.tree', 'anchors.tree']) {
    const text = readFileSync(join(FIXTURE, name), 'utf8')
    const value = oracle(text)
    const reference = encodeTree(value)
    const term = mod.codeOf(text) as Uint8Array

    ok(`${name}: Term writes the reference's bytes`, hex(term) === hex(reference), `\n      term ${hex(term)}\n      ref  ${hex(reference)}`)
    ok(`${name}: Term reads the reference's bytes back to the same long form`, mod.longOfCode(reference) === writeLong(value))
  }

  // ---- generated values, both ways ----

  const random = generator(20261006)
  const failures: string[] = []

  for (let at = 0; at < 1500; at++) {
    const value: Data = { kind: 'hash', list: [{ name: 'value', base: generated(random, 3) }] }
    const text = writeLong(value)
    const reference = encodeTree(oracle(text))

    try {
      const term = mod.codeOf(text) as Uint8Array
      const back = mod.longOfCode(reference) as string
      const recoded = mod.recode(reference) as Uint8Array
      const decoded = decodeTree(term)

      if (hex(term) !== hex(reference)) {
        failures.push(`bytes differ for ${JSON.stringify(text)}\n      term ${hex(term)}\n      ref  ${hex(reference)}`)
      } else if (back !== writeLong(oracle(text))) {
        failures.push(`Term read the reference's bytes to ${JSON.stringify(back)}, not ${JSON.stringify(text)}`)
      } else if (hex(recoded) !== hex(reference)) {
        failures.push(`Term's decode then encode changed the bytes of ${JSON.stringify(text)}`)
      } else if (!decoded.ok) {
        failures.push(`the reference refused Term's bytes: ${decoded.problem.message}`)
      }
    } catch (error) {
      failures.push(`${JSON.stringify(text)}: ${String(error)} ${JSON.stringify((error as { link?: unknown }).link ?? '')}`)
    }
  }

  ok('1500 generated values: Term and the reference write the same bytes and read each other\'s', failures.length === 0, `${failures.length} failed\n      ${failures.slice(0, 3).join('\n      ')}`)

  // ---- refusals, named as the reference names them ----

  const H = 'd3 54 52 01'
  const cases: [string, string][] = [
    ['7b 7d', 'not-tree-code'],
    ['d3 54 52 02 01 01 e0', 'unknown-version'],
    [`${H} 01 03 1c 80 00`, 'non-canonical'],
    [`${H} 01 07 82 42 68 69 42 68 69`, 'non-canonical'],
    [`${H} 01 08 82 a1 41 61 00 a1 60 01`, 'non-canonical'],
    [`${H} 01 09 e3 3f f0 00 00 00 00 00 00`, 'non-canonical'],
    [`${H} 01 09 e3 3f e0 00 00 00 00 00 00`, 'non-canonical'],
    [`${H} 01 02 e6 00`, 'unknown-tag'],
    [`${H} 01 01 1d`, 'unknown-tag'],
    [`${H} 01 09 e0`, 'truncated'],
    [`${H} 01 02 e0 e0`, 'frame-length'],
    [`${H} 01 01 e0 00 e0`, 'frame-length'],
    [`${H} 01 03 42 c3 28`, 'bad-text'],
    [`${H} 01 01 63`, 'bad-reference'],
    [`${H} 01 01 c0`, 'bad-reference'],
    [`${H} 01 06 a2 41 61 60 00 01`, 'repeated-key'],
    [`${H} 01 03 a1 00 00`, 'unknown-tag'],
    [`${H} 02 03 05 00 00`, 'no-decompressor'],
  ]

  for (const [stream, want] of cases) {
    const reference = decodeTree(bytes(stream))
    const named = reference.ok ? 'accepted' : reference.problem.name

    ok(`${stream.slice(0, 40)}: refused as ${want}, by both`, refusal(bytes(stream)) === want && named === want, `term ${refusal(bytes(stream))}, reference ${named}`)
  }

  ok('a canonical stream with an end marker is accepted by Term', refusal(bytes(`${H} 01 01 e0 00`)) === 'accepted')

  console.log('')
  console.log(`host-code-term: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }
}

main()
