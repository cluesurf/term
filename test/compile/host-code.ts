// `tree/code` (note/term/host/10-code.md): the worked example in the spec is the bytes the encoder writes; every
// fixture and thousands of generated values round trip, and decode then encode gives back the same bytes; every
// non-canonical spelling and every hostile input is refused by name; the encoder refuses what the model does not hold;
// a Zstandard frame is used only when smaller and reads back. Ends with sizes against JSON.
// Run: npx tsx test/compile/host-code.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import type { Data } from '@term/make/code/compile/host'
import { expandData, readDataText, toJson, writeCompact } from '@term/make/code/compile/host'
import { decodeTree, encodeTree, TreeCodeError } from '@term/make/code/compile/host-code'

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

const FIXTURE = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '../../deck/host/test/fixture')

const compress = (plain: Uint8Array): Uint8Array => new Uint8Array(zstdCompressSync(plain))
const decompress = (packed: Uint8Array, size: number): Uint8Array => new Uint8Array(zstdDecompressSync(packed, { maxOutputLength: size }))

function hex(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join(' ')
}

function bytes(text: string): Uint8Array {
  return Uint8Array.from(text.split(/\s+/).filter(Boolean).map(b => Number.parseInt(b, 16)))
}

function treeOf(text: string, file = 'x.tree'): Data {
  const read = readDataText({ file, text })

  if (!read.ok) {
    throw new Error(read.diagnostics.map(d => d.message).join(' | '))
  }

  const expanded = expandData(read.data, file)

  if (!expanded.ok) {
    throw new Error(expanded.diagnostics.map(d => d.message).join(' | '))
  }

  return expanded.data
}

// the value with its kinds, so `3` and `3.0` are told apart and order counts
function same(a: Data[], b: Data[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function roundTrip(name: string, values: Data[]): void {
  const encoded = encodeTree(values)
  const decoded = decodeTree(encoded)

  if (!decoded.ok) {
    ok(name, false, `${decoded.problem.name}: ${decoded.problem.message}`)
    return
  }

  const again = encodeTree(decoded.values)

  ok(name, same(values, decoded.values) && hex(again) === hex(encoded), same(values, decoded.values) ? 'decode then encode changed the bytes' : 'the value changed')
}

// the problem a hand-built stream is refused with
function refusal(stream: string, options = {}): string {
  const decoded = decodeTree(bytes(stream), options)

  return decoded.ok ? 'accepted' : decoded.problem.name
}

function encodeRefusal(value: Data): string {
  try {
    encodeTree(value)

    return 'accepted'
  } catch (cause) {
    return cause instanceof TreeCodeError ? cause.problem.name : String(cause)
  }
}

// a deterministic generator, so a failure is the same failure on the next run
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

const WORDS = ['name', 'age', 'active', 'tags', 'a', 'b', '', 'é', '世界', '😀', 'x-y', 'id', '<>{}', 'line\nbreak']
const KEYS = ['name', 'age', 'active', 'tags', 'id', 'kind', 'size', 'note']

function generated(random: () => number, depth: number): Data {
  const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)] as T
  const roll = random()

  if (depth > 0 && roll < 0.15) {
    const size = Math.floor(random() * 6)

    return { kind: 'list', list: Array.from({ length: size }, () => generated(random, depth - 1)) }
  }

  if (depth > 0 && roll < 0.3) {
    const keys = KEYS.filter(() => random() < 0.5)

    return { kind: 'hash', list: keys.map(name => ({ name, base: generated(random, depth - 1) })) }
  }

  switch (Math.floor(random() * 8)) {
    case 0:
      return { kind: 'number', value: Math.floor((random() - 0.5) * 2 ** Math.floor(random() * 60)) }
    case 1:
      return { kind: 'number', value: pick([0, 1, 27, 28, -1, -28, -29, 255, 2 ** 53, -(2 ** 53), 2 ** 60, -(2 ** 70)]) }
    case 2:
      return { kind: 'decimal', value: pick([0, 1, -1, 0.5, 0.1, -2.75, 1e300, -1e-300, 3.25, 2 ** 53, 2 ** 60, 123456.789, -0]) }
    case 3:
      return { kind: 'decimal', value: (random() - 0.5) * 10 ** Math.floor(random() * 20) }
    case 4:
      return { kind: 'text', value: pick(WORDS) }
    case 5:
      return { kind: 'flag', value: random() < 0.5 }
    case 6:
      return { kind: 'void' }
    default:
      return { kind: 'text', value: pick(WORDS) + pick(WORDS) }
  }
}

function main(): void {
  // ---- the spec's worked example is what the encoder writes ----

  const example = treeOf(
    'list member\n  mesh\n    host name, <ada>\n    host age, 36\n    host active, true\n  mesh\n    host name, <alan>\n    host age, 41\n    host active, false\n',
  )
  const written = encodeTree(example)
  const spec =
    'd3 54 52 01 01 2a a1 46 6d 65 6d 62 65 72 82 a3 44 6e 61 6d 65 43 61 67 65 46 61 63 74 69 76 65 43 61 64 61 1c 08 e1 c1 44 61 6c 61 6e 1c 0d e0'

  ok('the worked example in 10-code.md is byte for byte what the encoder writes', hex(written) === spec, hex(written))
  ok(`...and it is ${written.length} bytes against ${toJson(example).length} of minified JSON`, written.length < toJson(example).length)

  // ---- fixtures ----

  for (const name of ['basic.tree', 'anchors.tree']) {
    roundTrip(`fixture ${name} round trips, and decode then encode is the identity`, [treeOf(readFileSync(join(FIXTURE, name), 'utf8'), name)])
  }

  // the stream declares its anchors first and fuses them later, so it is read whole and sent a record per frame
  const whole = treeOf(readFileSync(join(FIXTURE, 'stream.line'), 'utf8'), 'stream.line')
  const stream = whole.kind === 'list' ? whole.list : whole.kind === 'hash' ? whole.list.map(entry => entry.base) : [whole]

  roundTrip(`the stream fixture, ${stream.length} records, one frame each`, stream)

  // ---- generated values ----

  const random = generator(20261006)
  let generatedFailures = 0

  for (let at = 0; at < 3000; at++) {
    const value = generated(random, 4)
    const encoded = encodeTree(value)
    const decoded = decodeTree(encoded)

    if (!decoded.ok || !same([value], decoded.values) || hex(encodeTree(decoded.values)) !== hex(encoded) || hex(encodeTree(value)) !== hex(encoded)) {
      generatedFailures++

      if (generatedFailures <= 3) {
        console.log(`  value ${JSON.stringify(value).slice(0, 200)}`)
        console.log(`  ${decoded.ok ? 'round trip changed it' : `${decoded.problem.name}: ${decoded.problem.message}`}`)
      }
    }
  }

  ok('3000 generated values: each round trips, encodes the same twice, and decode then encode is the identity', generatedFailures === 0, `${generatedFailures} failed`)

  // ---- the canonical spelling, and nothing else ----

  const H = 'd3 54 52 01'

  ok('a list of 2 is accepted written canonically', refusal(`${H} 01 03 82 00 01`) === 'accepted')
  ok('a count under 28 written long (28 and a varint) cannot be spelled: 28 + varint is always 28 or more', refusal(`${H} 01 02 1c 00`) === 'accepted' && decodeTree(bytes(`${H} 01 02 1c 00`)).ok && JSON.stringify((decodeTree(bytes(`${H} 01 02 1c 00`)) as { values: Data[] }).values) === '[{"kind":"number","value":28}]')
  ok('a varint with a trailing zero group is refused', refusal(`${H} 01 03 1c 80 00`) === 'non-canonical')
  ok('a text written again where a reference belongs is refused', refusal(`${H} 01 07 82 42 68 69 42 68 69`) === 'non-canonical')
  ok('a reference to the first copy is the canonical spelling', refusal(`${H} 01 05 82 42 68 69 60`) === 'accepted')
  ok('a shape written again where a reference belongs is refused', refusal(`${H} ${frame('82 a1 41 61 00 a1 60 01')}`) === 'non-canonical')
  ok('...and the reference to it is the canonical spelling', refusal(`${H} ${frame('82 a1 41 61 00 c0 01')}`) === 'accepted')
  ok('the decimal 1.0 written as a double is refused (it is simple 5)', refusal(`${H} 01 09 e3 3f f0 00 00 00 00 00 00`) === 'non-canonical')
  ok('the decimal 0.5 written as a double is refused (a single holds it)', refusal(`${H} 01 09 e3 3f e0 00 00 00 00 00 00`) === 'non-canonical')
  ok('the decimal 0.1 as a double is accepted (no single holds it)', refusal(`${H} 01 09 e3 3f b9 99 99 99 99 99 9a`) === 'accepted')
  ok('a whole decimal past 2^53 inside simple 5 is refused', refusal(`${H} ${frame(`e5 1c ${hex(varint(2n ** 53n - 28n))}`)}`) === 'non-canonical')
  ok('...and one just under it is accepted', refusal(`${H} ${frame(`e5 1c ${hex(varint(2n ** 53n - 29n))}`)}`) === 'accepted')

  // ---- hostile and broken input ----

  ok('a stream without the header is refused', refusal('7b 7d') === 'not-tree-code')
  ok('a version this decoder does not read is refused', refusal('d3 54 52 02 01 01 e0') === 'unknown-version')
  ok('an unknown frame kind is refused', refusal(`${H} 07 01 e0`) === 'unknown-tag')
  ok('a reserved simple (bytes, 6) is refused until it is defined', refusal(`${H} 01 02 e6 00`) === 'unknown-tag')
  ok('minor 29 is refused', refusal(`${H} 01 01 1d`) === 'unknown-tag')
  ok('a frame longer than the input is refused', refusal(`${H} 01 09 e0`) === 'truncated')
  ok('bytes left in a frame after its value are refused', refusal(`${H} 01 02 e0 e0`) === 'frame-length')
  ok('bytes after the end of the stream are refused', refusal(`${H} 01 01 e0 00 e0`) === 'frame-length')
  ok('the end of the stream marker is accepted', refusal(`${H} 01 01 e0 00`) === 'accepted')
  ok('invalid UTF-8 in a text is refused', refusal(`${H} 01 03 42 c3 28`) === 'bad-text')
  ok('a reference to a text that does not exist is refused', refusal(`${H} 01 01 63`) === 'bad-reference')
  ok('a reference to a shape that does not exist is refused', refusal(`${H} 01 01 c0`) === 'bad-reference')
  ok('a key twice in one shape is refused', refusal(`${H} 01 06 a2 41 61 60 00 01`) === 'repeated-key')
  ok('a key that is not a text is refused', refusal(`${H} 01 03 a1 00 00`) === 'unknown-tag')
  ok('a list claiming 2^40 items in 6 bytes is refused before anything is allocated', refusal(`${H} 01 07 9c ${hex(varint(2n ** 40n))}`) === 'truncated')
  ok('nesting past the depth limit is refused, not a stack overflow', refusal(`${H} 01 0a ${'81 '.repeat(9)}e0`, { limits: { depth: 5 } }) === 'too-deep')

  // ---- the encoder refuses what the model does not hold ----

  ok('NaN is refused by the encoder', encodeRefusal({ kind: 'decimal', value: Number.NaN }) === 'unencodable')
  ok('infinity is refused by the encoder', encodeRefusal({ kind: 'decimal', value: Number.POSITIVE_INFINITY }) === 'unencodable')
  ok('a lone surrogate is refused, never written as U+FFFD', encodeRefusal({ kind: 'text', value: 'a\ud800b' }) === 'unencodable')
  ok('a key twice in one map is refused', encodeRefusal({ kind: 'hash', list: [{ name: 'a', base: { kind: 'void' } }, { name: 'a', base: { kind: 'void' } }] }) === 'unencodable')
  ok('an unexpanded fuse is refused', encodeRefusal({ kind: 'fuse', name: 'x' }) === 'unencodable')
  roundTrip('a surrogate pair (an emoji) is carried exactly', [{ kind: 'text', value: '😀 👩‍👩‍👧 \u{10ffff}' }])
  roundTrip('integers past 2^53, both signs, carried exactly as the model holds them', [{ kind: 'list', list: [2 ** 60, -(2 ** 70), Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER].map(value => ({ kind: 'number' as const, value })) }])
  roundTrip('negative zero as a decimal stays negative zero', [{ kind: 'decimal', value: -0 }])

  // ---- Zstandard frames ----

  const records = dataset(1000)
  const plain = encodeTree(records)
  const packed = encodeTree(records, { compress })
  const unpacked = decodeTree(packed, { decompress })

  ok('a large frame is stored as Zstandard, and is smaller', packed[4] === 0x02 && packed.length < plain.length, `${packed.length} vs ${plain.length}`)
  ok('...and decodes to the same value', unpacked.ok && same([records], unpacked.values))
  ok('...and a decoder without a decompressor says so', refusal(hex(packed)) === 'no-decompressor')
  ok('...and one that declares more than the limit is refused before decompressing', !decodeTree(packed, { decompress, limits: { frame: 100 } }).ok && (decodeTree(packed, { decompress, limits: { frame: 100 } }) as { problem: { name: string } }).problem.name === 'too-large')

  const tiny = encodeTree({ kind: 'flag', value: true }, { compress })

  ok('a tiny value stays a plain frame even when compression is offered', tiny[4] === 0x01 && tiny.length === 7, hex(tiny))

  // ---- sizes ----

  console.log('')
  console.log('  bytes                         JSON   JSON+zstd   compact   tree/code   tree/code+zstd')

  const rows: [string, Data][] = [
    ['basic.tree', treeOf(readFileSync(join(FIXTURE, 'basic.tree'), 'utf8'), 'basic.tree')],
    ['the worked example', example],
    ['1000 records', records],
  ]

  for (const [label, value] of rows) {
    const json = new TextEncoder().encode(toJson(value))
    const cells = [
      json.length,
      zstdCompressSync(json).length,
      new TextEncoder().encode(writeCompact(value)).length,
      encodeTree(value).length,
      encodeTree(value, { compress, compressAbove: 0 }).length,
    ]

    console.log(`  ${label.padEnd(28)}${cells.map(c => String(c).padStart(c === cells[0] ? 6 : 12)).join('')}`)
  }

  console.log('')
  console.log(`host-code: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }
}

// a plain frame around a value's bytes, its length counted
function frame(body: string): string {
  const value = bytes(body)

  return `01 ${hex(varint(BigInt(value.length)))} ${hex(value)}`
}

function varint(n: bigint): Uint8Array {
  const out: number[] = []
  let rest = n

  do {
    const low = Number(rest & 0x7fn)

    rest >>= 7n
    out.push(rest > 0n ? low | 0x80 : low)
  } while (rest > 0n)

  return Uint8Array.from(out)
}

// records of the kind a web response carries: repeated keys, repeated values, small numbers, some decimals
function dataset(count: number): Data {
  const random = generator(7)
  const roles = ['admin', 'editor', 'viewer']
  const list: Data[] = []

  for (let at = 0; at < count; at++) {
    list.push({
      kind: 'hash',
      list: [
        { name: 'id', base: { kind: 'number', value: 100000 + at } },
        { name: 'name', base: { kind: 'text', value: `user-${Math.floor(random() * 5000)}` } },
        { name: 'role', base: { kind: 'text', value: roles[at % 3] as string } },
        { name: 'active', base: { kind: 'flag', value: random() < 0.8 } },
        { name: 'score', base: { kind: 'decimal', value: Math.round(random() * 10000) / 100 } },
        { name: 'tags', base: { kind: 'list', list: [{ kind: 'text', value: 'a' }, { kind: 'text', value: random() < 0.5 ? 'b' : 'c' }] } },
      ],
    })
  }

  return { kind: 'hash', list: [{ name: 'users', base: { kind: 'list', list } }] }
}

main()
