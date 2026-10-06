// `tree/code`: the encoded form of Term data, the reference encoder and decoder. The spec is note/term/host/10-code.md
// and every rule here is a rule there. One model, two encodings: `tree/text` (host.ts) and this, so a value decoded
// here is the `Data` host.ts reads, and decode then encode gives back the same bytes.
//
// Pure and browser-safe, like host.ts. A Zstandard frame needs a compressor, which is INJECTED (`compress`,
// `decompress`), so this module never imports zlib: call/code/mold.ts passes Node's.

import type { Data, DataEntry } from '@term/make/code/compile/host'

export const MAGIC = [0xd3, 0x54, 0x52] as const
export const VERSION = 1

const FRAME_END = 0x00
const FRAME_PLAIN = 0x01
const FRAME_ZSTD = 0x02

const MAJOR_INTEGER = 0
const MAJOR_NEGATIVE = 1
const MAJOR_TEXT = 2
const MAJOR_TEXT_REF = 3
const MAJOR_LIST = 4
const MAJOR_SHAPE = 5
const MAJOR_SHAPE_REF = 6
const MAJOR_SIMPLE = 7

const SIMPLE_FALSE = 0
const SIMPLE_TRUE = 1
const SIMPLE_VOID = 2
const SIMPLE_DOUBLE = 3
const SIMPLE_SINGLE = 4
const SIMPLE_WHOLE = 5

// a count under this is the minor itself
const INLINE = 28

// 2^53: a whole decimal at or past it is written as a double, never as an integer
const WHOLE = 2 ** 53

export type CodeLimits = {
  // how deep lists and maps may nest
  depth: number
  // the most a Zstandard frame may decompress to
  frame: number
}

export const LIMITS: CodeLimits = { depth: 256, frame: 64 * 1024 * 1024 }

export type CodeError = {
  // a stable name, the way a diagnostic has one
  name: 'not-tree-code' | 'unknown-version' | 'truncated' | 'unknown-tag' | 'non-canonical' | 'bad-text' | 'bad-reference' | 'repeated-key' | 'too-deep' | 'too-large' | 'frame-length' | 'no-decompressor' | 'unencodable'
  message: string
  // the byte the problem was found at, in the input
  at: number
}

export class TreeCodeError extends Error {
  readonly problem: CodeError

  constructor(problem: CodeError) {
    super(problem.message)
    this.problem = problem
  }
}

// ---- encoding ----

export type EncodeOptions = {
  // store a frame as Zstandard when that makes it smaller and it is at least `compressAbove` bytes. Off by default:
  // the canonical encoding is plain frames
  compress?: (plain: Uint8Array) => Uint8Array
  compressAbove?: number
  // write the end-of-stream byte
  end?: boolean
}

// the canonical `tree/code` of one value, or of several (one frame each)
export function encodeTree(values: Data | Data[], options: EncodeOptions = {}): Uint8Array {
  const out = new Writer()

  out.bytes(MAGIC)
  out.byte(VERSION)

  for (const value of Array.isArray(values) ? values : [values]) {
    writeFrame(out, value, options)
  }

  if (options.end) {
    out.byte(FRAME_END)
  }

  return out.finish()
}

// one frame, without a header: the unit a stream writer appends
export function encodeFrame(value: Data, options: EncodeOptions = {}): Uint8Array {
  const out = new Writer()

  writeFrame(out, value, options)

  return out.finish()
}

export function encodeHeader(): Uint8Array {
  return Uint8Array.from([...MAGIC, VERSION])
}

function writeFrame(out: Writer, value: Data, options: EncodeOptions): void {
  const body = new Writer()

  writeValue(body, value, { texts: new Map(), shapes: new Map() })

  const plain = body.finish()
  const above = options.compressAbove ?? 256

  if (options.compress && plain.length >= above) {
    const packed = options.compress(plain)
    const size = new Writer()

    size.varint(plain.length)

    // the compressed frame is used only when it is smaller, counting the extra length it carries
    if (packed.length + size.length < plain.length) {
      out.byte(FRAME_ZSTD)
      out.varint(size.length + packed.length)
      out.varint(plain.length)
      out.bytes(packed)

      return
    }
  }

  out.byte(FRAME_PLAIN)
  out.varint(plain.length)
  out.bytes(plain)
}

type Tables = {
  // a text to the FIRST index it was added at
  texts: Map<string, number>
  // a shape, its keys joined by a separator no key can hold, to its index
  shapes: Map<string, number>
}

// keys are joined by U+0000 to name a shape: a UTF-8 text can hold U+0000, so the count leads, which no key can forge
function shapeName(keys: string[]): string {
  return `${keys.length}\u0000${keys.join('\u0000')}`
}

function writeValue(out: Writer, value: Data, tables: Tables): void {
  switch (value.kind) {
    case 'number':
      writeInteger(out, value.value)
      return
    case 'decimal':
      writeDecimal(out, value.value)
      return
    case 'text':
      writeText(out, value.value, tables)
      return
    case 'flag':
      out.byte(tag(MAJOR_SIMPLE, value.value ? SIMPLE_TRUE : SIMPLE_FALSE))
      return
    case 'void':
      out.byte(tag(MAJOR_SIMPLE, SIMPLE_VOID))
      return
    case 'list':
      out.head(MAJOR_LIST, value.list.length)

      for (const item of value.list) {
        writeValue(out, item, tables)
      }

      return
    case 'hash':
      writeHash(out, value.list, tables)
      return
    case 'fuse':
      throw unencodable(`an unexpanded \`fuse ${value.name}\`: expand the anchors before encoding`)
  }
}

function writeHash(out: Writer, entries: DataEntry[], tables: Tables): void {
  const keys = entries.map(entry => entry.name)

  if (new Set(keys).size !== keys.length) {
    const repeated = keys.find((key, at) => keys.indexOf(key) !== at)

    throw unencodable(`"${repeated}" is a key twice in one map`)
  }

  const name = shapeName(keys)
  const known = tables.shapes.get(name)

  if (known !== undefined) {
    out.head(MAJOR_SHAPE_REF, known)
  } else {
    out.head(MAJOR_SHAPE, keys.length)

    for (const key of keys) {
      writeText(out, key, tables)
    }

    tables.shapes.set(name, tables.shapes.size)
  }

  for (const entry of entries) {
    writeValue(out, entry.base, tables)
  }
}

function writeText(out: Writer, value: string, tables: Tables): void {
  if (value.length > 0) {
    const known = tables.texts.get(value)

    if (known !== undefined) {
      out.head(MAJOR_TEXT_REF, known)

      return
    }
  }

  const bytes = utf8(value)

  out.head(MAJOR_TEXT, bytes.length)
  out.bytes(bytes)

  if (value.length > 0) {
    tables.texts.set(value, tables.texts.size)
  }
}

function writeInteger(out: Writer, value: number): void {
  if (!Number.isInteger(value)) {
    throw unencodable(`${value} is an integer value that is not whole`)
  }

  if (value >= 0) {
    out.head(MAJOR_INTEGER, value)
  } else {
    out.headBig(MAJOR_NEGATIVE, -1n - BigInt(value))
  }
}

function writeDecimal(out: Writer, value: number): void {
  if (!Number.isFinite(value)) {
    throw unencodable(`${value} is not a value Term data holds: tree/text has no spelling for it`)
  }

  if (Number.isInteger(value) && Math.abs(value) < WHOLE && !Object.is(value, -0)) {
    out.byte(tag(MAJOR_SIMPLE, SIMPLE_WHOLE))
    writeInteger(out, value)

    return
  }

  if (Math.fround(value) === value && !Object.is(value, -0)) {
    const view = new DataView(new ArrayBuffer(4))

    view.setFloat32(0, value)
    out.byte(tag(MAJOR_SIMPLE, SIMPLE_SINGLE))
    out.bytes(new Uint8Array(view.buffer))

    return
  }

  const view = new DataView(new ArrayBuffer(8))

  view.setFloat64(0, value)
  out.byte(tag(MAJOR_SIMPLE, SIMPLE_DOUBLE))
  out.bytes(new Uint8Array(view.buffer))
}

function tag(major: number, minor: number): number {
  return (major << 5) | minor
}

function unencodable(message: string): TreeCodeError {
  return new TreeCodeError({ name: 'unencodable', message, at: 0 })
}

// UTF-8, refusing a lone surrogate: TextEncoder would write U+FFFD in its place and the value would change
function utf8(value: string): Uint8Array {
  for (let at = 0; at < value.length; at++) {
    const unit = value.charCodeAt(at)

    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(at + 1)

      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw unencodable(`a text holds a lone surrogate at ${at}, which UTF-8 cannot carry`)
      }

      at++
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw unencodable(`a text holds a lone surrogate at ${at}, which UTF-8 cannot carry`)
    }
  }

  return ENCODER.encode(value)
}

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder('utf-8', { fatal: true })

// a growable byte buffer, doubled when full
class Writer {
  private buffer = new Uint8Array(256)
  private used = 0

  get length(): number {
    return this.used
  }

  private room(n: number): void {
    if (this.used + n <= this.buffer.length) {
      return
    }

    let size = this.buffer.length * 2

    while (size < this.used + n) {
      size *= 2
    }

    const grown = new Uint8Array(size)

    grown.set(this.buffer.subarray(0, this.used))
    this.buffer = grown
  }

  byte(value: number): void {
    this.room(1)
    this.buffer[this.used++] = value & 0xff
  }

  bytes(values: ArrayLike<number>): void {
    this.room(values.length)

    if (values instanceof Uint8Array) {
      this.buffer.set(values, this.used)
    } else {
      for (let at = 0; at < values.length; at++) {
        this.buffer[this.used + at] = values[at] as number
      }
    }

    this.used += values.length
  }

  // a count: the minor when under 28, else 28 and the varint of what is past it
  head(major: number, n: number): void {
    if (n < INLINE) {
      this.byte(tag(major, n))
    } else {
      this.byte(tag(major, INLINE))
      this.varintBig(BigInt(n) - BigInt(INLINE))
    }
  }

  headBig(major: number, n: bigint): void {
    if (n < BigInt(INLINE)) {
      this.byte(tag(major, Number(n)))
    } else {
      this.byte(tag(major, INLINE))
      this.varintBig(n - BigInt(INLINE))
    }
  }

  varint(n: number): void {
    this.varintBig(BigInt(n))
  }

  varintBig(n: bigint): void {
    let rest = n

    do {
      const low = Number(rest & 0x7fn)

      rest >>= 7n
      this.byte(rest > 0n ? low | 0x80 : low)
    } while (rest > 0n)
  }

  finish(): Uint8Array {
    return this.buffer.slice(0, this.used)
  }
}

// ---- decoding ----

export type DecodeOptions = {
  decompress?: (packed: Uint8Array, size: number) => Uint8Array
  limits?: Partial<CodeLimits>
}

export type DecodeResult = { ok: true; values: Data[] } | { ok: false; problem: CodeError }

// every value of a stream, or the first problem in it
export function decodeTree(input: Uint8Array, options: DecodeOptions = {}): DecodeResult {
  try {
    return { ok: true, values: [...readFrames(input, options)] }
  } catch (cause) {
    if (cause instanceof TreeCodeError) {
      return { ok: false, problem: cause.problem }
    }

    throw cause
  }
}

// the values of a stream one frame at a time: the tables of each are dropped before the next is read. Throws
// `TreeCodeError` at the first problem
export function* readFrames(input: Uint8Array, options: DecodeOptions = {}): Generator<Data> {
  const limits = { ...LIMITS, ...options.limits }
  const reader = new Reader(input, 0, input.length)

  readHeader(reader)

  while (!reader.done()) {
    const kind = reader.byte()

    if (kind === FRAME_END) {
      if (!reader.done()) {
        throw reader.fail('frame-length', 'bytes follow the end of the stream')
      }

      return
    }

    if (kind !== FRAME_PLAIN && kind !== FRAME_ZSTD) {
      throw reader.fail('unknown-tag', `0x${hex(kind)} is not a frame kind`, reader.at - 1)
    }

    const length = reader.count()
    const start = reader.at

    if (length > reader.left()) {
      throw reader.fail('truncated', `the frame says ${length} bytes and ${reader.left()} are left`)
    }

    reader.skip(length)

    if (kind === FRAME_PLAIN) {
      yield readFrameValue(new Reader(input, start, start + length), limits)
    } else {
      yield readPackedFrame(new Reader(input, start, start + length), options, limits)
    }
  }
}

function readHeader(reader: Reader): void {
  if (reader.left() < 4 || MAGIC.some((byte, at) => reader.peek(at) !== byte)) {
    throw reader.fail('not-tree-code', 'the input does not start with the tree/code header (d3 54 52)')
  }

  reader.skip(3)

  const version = reader.byte()

  if (version !== VERSION) {
    throw reader.fail('unknown-version', `tree/code version ${version}, and this decoder reads version ${VERSION}`, 3)
  }
}

function readPackedFrame(reader: Reader, options: DecodeOptions, limits: CodeLimits): Data {
  const size = reader.count()

  if (size > limits.frame) {
    throw reader.fail('too-large', `a compressed frame says it holds ${size} bytes, past the limit of ${limits.frame}`)
  }

  if (!options.decompress) {
    throw reader.fail('no-decompressor', 'a Zstandard frame, and no decompressor was given')
  }

  const plain = options.decompress(reader.rest(), size)

  if (plain.length !== size) {
    throw reader.fail('frame-length', `a compressed frame says ${size} bytes and holds ${plain.length}`)
  }

  return readFrameValue(new Reader(plain, 0, plain.length), limits)
}

// a frame's tables as the decoder holds them: by index to read a reference, and by value to refuse a repeat
type ReadTables = { texts: string[]; known: Set<string>; shapes: string[][]; shaped: Set<string> }

function readFrameValue(reader: Reader, limits: CodeLimits): Data {
  const tables: ReadTables = { texts: [], known: new Set(), shapes: [], shaped: new Set() }
  const value = readValue(reader, tables, limits, 0)

  if (!reader.done()) {
    throw reader.fail('frame-length', `the frame holds ${reader.left()} bytes past its value`)
  }

  return value
}

function readValue(reader: Reader, tables: ReadTables, limits: CodeLimits, depth: number): Data {
  if (depth > limits.depth) {
    throw reader.fail('too-deep', `values nest deeper than ${limits.depth}`)
  }

  const at = reader.at
  const first = reader.byte()
  const major = first >> 5
  const minor = first & 0x1f

  if (major === MAJOR_SIMPLE) {
    return readSimple(reader, minor, at, tables, limits, depth)
  }

  if (major === MAJOR_INTEGER || major === MAJOR_NEGATIVE) {
    const n = reader.headBig(minor, at)
    const value = major === MAJOR_INTEGER ? n : -1n - n

    return { kind: 'number', value: Number(value) }
  }

  const n = reader.head(minor, at)

  switch (major) {
    case MAJOR_TEXT: {
      if (n > reader.left()) {
        throw reader.fail('truncated', `a text of ${n} bytes, and ${reader.left()} are left`, at)
      }

      const value = reader.text(n)

      if (value.length > 0) {
        if (tables.known.has(value)) {
          throw reader.fail('non-canonical', `"${clip(value)}" is written again where a reference to it belongs`, at)
        }

        tables.texts.push(value)
        tables.known.add(value)
      }

      return { kind: 'text', value }
    }
    case MAJOR_TEXT_REF: {
      const value = tables.texts[n]

      if (value === undefined) {
        throw reader.fail('bad-reference', `text ${n} is referred to, and the frame has ${tables.texts.length}`, at)
      }

      return { kind: 'text', value }
    }
    case MAJOR_LIST: {
      // every value takes at least a byte, so a count past what is left is a lie told before anything is allocated
      if (n > reader.left()) {
        throw reader.fail('truncated', `a list of ${n} values, and ${reader.left()} bytes are left`, at)
      }

      const list: Data[] = []

      for (let item = 0; item < n; item++) {
        list.push(readValue(reader, tables, limits, depth + 1))
      }

      return { kind: 'list', list }
    }
    case MAJOR_SHAPE: {
      if (n * 2 > reader.left()) {
        throw reader.fail('truncated', `a map of ${n} keys, and ${reader.left()} bytes are left`, at)
      }

      const keys: string[] = []

      for (let key = 0; key < n; key++) {
        const keyAt = reader.at
        const read = readValue(reader, tables, limits, depth + 1)

        if (read.kind !== 'text') {
          throw reader.fail('unknown-tag', 'a key of a map is not a text', keyAt)
        }

        if (keys.includes(read.value)) {
          throw reader.fail('repeated-key', `"${clip(read.value)}" is a key twice in one shape`, keyAt)
        }

        keys.push(read.value)
      }

      const name = shapeName(keys)

      if (tables.shaped.has(name)) {
        throw reader.fail('non-canonical', 'a shape is written again where a reference to it belongs', at)
      }

      tables.shapes.push(keys)
      tables.shaped.add(name)

      return readEntries(reader, keys, tables, limits, depth)
    }
    case MAJOR_SHAPE_REF: {
      const keys = tables.shapes[n]

      if (keys === undefined) {
        throw reader.fail('bad-reference', `shape ${n} is referred to, and the frame has ${tables.shapes.length}`, at)
      }

      return readEntries(reader, keys, tables, limits, depth)
    }
  }

  throw reader.fail('unknown-tag', `0x${hex(first)} is not a tag`, at)
}

function readEntries(reader: Reader, keys: string[], tables: ReadTables, limits: CodeLimits, depth: number): Data {
  if (keys.length > reader.left()) {
    throw reader.fail('truncated', `a map of ${keys.length} values, and ${reader.left()} bytes are left`)
  }

  const list: DataEntry[] = []

  for (const name of keys) {
    list.push({ name, base: readValue(reader, tables, limits, depth + 1) })
  }

  return { kind: 'hash', list }
}

function readSimple(reader: Reader, minor: number, at: number, tables: ReadTables, limits: CodeLimits, depth: number): Data {
  switch (minor) {
    case SIMPLE_FALSE:
      return { kind: 'flag', value: false }
    case SIMPLE_TRUE:
      return { kind: 'flag', value: true }
    case SIMPLE_VOID:
      return { kind: 'void' }
    case SIMPLE_DOUBLE: {
      const value = reader.view(8).getFloat64(0)

      if (!Number.isFinite(value)) {
        throw reader.fail('unknown-tag', 'a decimal that is not finite, which Term data does not hold', at)
      }

      if ((Number.isInteger(value) && Math.abs(value) < WHOLE && !Object.is(value, -0)) || (Math.fround(value) === value && !Object.is(value, -0))) {
        throw reader.fail('non-canonical', `the decimal ${value} is written as a double, and a shorter form holds it`, at)
      }

      return { kind: 'decimal', value }
    }
    case SIMPLE_SINGLE: {
      const value = reader.view(4).getFloat32(0)

      if (!Number.isFinite(value)) {
        throw reader.fail('unknown-tag', 'a decimal that is not finite, which Term data does not hold', at)
      }

      if ((Number.isInteger(value) && Math.abs(value) < WHOLE) || Object.is(value, -0)) {
        throw reader.fail('non-canonical', `the decimal ${value} is written as a single, and it belongs elsewhere`, at)
      }

      return { kind: 'decimal', value }
    }
    case SIMPLE_WHOLE: {
      const inner = readValue(reader, tables, limits, depth + 1)

      if (inner.kind !== 'number' || Math.abs(inner.value) >= WHOLE) {
        throw reader.fail('non-canonical', 'a whole decimal holds something other than an integer under 2^53', at)
      }

      return { kind: 'decimal', value: inner.value }
    }
  }

  throw reader.fail('unknown-tag', `simple ${minor} is not defined in tree/code version ${VERSION}`, at)
}

class Reader {
  at: number

  constructor(
    private readonly input: Uint8Array,
    start: number,
    private readonly end: number,
  ) {
    this.at = start
  }

  done(): boolean {
    return this.at >= this.end
  }

  left(): number {
    return this.end - this.at
  }

  peek(offset: number): number | undefined {
    return this.at + offset < this.end ? this.input[this.at + offset] : undefined
  }

  byte(): number {
    if (this.at >= this.end) {
      throw this.fail('truncated', 'the input ends inside a value')
    }

    return this.input[this.at++] as number
  }

  skip(n: number): void {
    this.at += n
  }

  rest(): Uint8Array {
    const out = this.input.subarray(this.at, this.end)

    this.at = this.end

    return out
  }

  view(n: number): DataView {
    if (n > this.left()) {
      throw this.fail('truncated', `${n} bytes are needed and ${this.left()} are left`)
    }

    const out = new DataView(this.input.buffer, this.input.byteOffset + this.at, n)

    this.at += n

    return out
  }

  text(n: number): string {
    const bytes = this.input.subarray(this.at, this.at + n)

    try {
      const value = DECODER.decode(bytes)

      this.at += n

      return value
    } catch {
      throw this.fail('bad-text', 'a text is not valid UTF-8')
    }
  }

  // a count that must fit a JavaScript number exactly
  head(minor: number, at: number): number {
    const n = this.headBig(minor, at)

    if (n > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw this.fail('too-large', `a count of ${n}`, at)
    }

    return Number(n)
  }

  headBig(minor: number, at: number): bigint {
    if (minor < INLINE) {
      return BigInt(minor)
    }

    if (minor !== INLINE) {
      throw this.fail('unknown-tag', `minor ${minor} is not defined`, at)
    }

    return BigInt(INLINE) + this.varintBig()
  }

  count(): number {
    const n = this.varintBig()

    if (n > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw this.fail('too-large', `a length of ${n}`)
    }

    return Number(n)
  }

  varintBig(): bigint {
    const start = this.at
    let value = 0n
    let shift = 0n
    let last = 0

    for (;;) {
      last = this.byte()
      value |= BigInt(last & 0x7f) << shift
      shift += 7n

      if ((last & 0x80) === 0) {
        break
      }
    }

    // the shortest form: a varint of more than one byte never ends in a zero group
    if (this.at - start > 1 && last === 0) {
      throw this.fail('non-canonical', 'a varint is longer than it needs to be', start)
    }

    return value
  }

  fail(name: CodeError['name'], message: string, at = this.at): TreeCodeError {
    return new TreeCodeError({ name, message, at })
  }
}

function hex(byte: number): string {
  return byte.toString(16).padStart(2, '0')
}

function clip(value: string): string {
  return value.length > 40 ? `${value.slice(0, 40)}...` : value
}
