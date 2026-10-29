// `tree/code`: the encoded form of Term data. The spec is note/project/term/host/10-code.md. The codec is Term,
// @term/host's code.tree, reached through compile/host-codec.tree (decision 041 of
// note/project/term/self-host/change/001-finish-self-host): this face keeps the compiler's API, converts host.ts's
// `Data` to and from Term's `data`, and turns a `code-defect` into a `TreeCodeError` with its name, message and byte.
//
// Pure and browser-safe, like host.ts. A Zstandard frame needs a compressor, which is INJECTED (`compress`,
// `decompress`), so this module never imports zlib: call/code/mold.ts passes Node's.

import type { Data, DataEntry } from '@term/make/code/compile/host'
import {
  blankData,
  codeReaderMore,
  encodeCode,
  encodeCodeFrame,
  encodeCodeHeader,
  openCodeReader,
  readCodeFrame,
} from '@term/make/code/compile/host-codec'

export const MAGIC = [0xd3, 0x54, 0x52] as const
export const VERSION = 1

export type CodeLimits = {
  // how deep lists and maps may nest
  depth: number
  // the most a Zstandard frame may decompress to
  frame: number
}

export const LIMITS: CodeLimits = {
  depth: 256,
  frame: 64 * 1024 * 1024,
}

export type CodeError = {
  // a stable name, the way a diagnostic has one
  name:
    | 'not-tree-code'
    | 'unknown-version'
    | 'truncated'
    | 'unknown-tag'
    | 'non-canonical'
    | 'bad-text'
    | 'bad-reference'
    | 'repeated-key'
    | 'too-deep'
    | 'too-large'
    | 'frame-length'
    | 'no-decompressor'
    | 'unencodable'
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

// ---- Term's data ----

type TermData = ReturnType<typeof blankData>
type TermEntry = { name: string; base: TermData }

const BLANK = blankData()

function toTerm(value: Data): TermData {
  switch (value.kind) {
    case 'list':
      return { form: 'array', list: value.list.map(toTerm) }
    case 'hash':
      return {
        form: 'hash',
        list: value.list.map(entry => ({
          name: entry.name,
          base: toTerm(entry.base),
        })),
      }
    case 'void':
      return BLANK
    case 'fuse':
      return { form: 'graft', name: value.name }
    case 'number':
      return { form: 'number', value: value.value }
    case 'decimal':
      return { form: 'decimal', value: value.value }
    case 'text':
      return { form: 'text', value: value.value }
    case 'flag':
      return { form: 'flag', value: value.value }
  }
}

function fromTerm(value: TermData): Data {
  switch (value.form) {
    case 'array':
      return { kind: 'list', list: value.list.map(fromTerm) }
    case 'hash':
      return {
        kind: 'hash',
        list: value.list.map(
          (entry: TermEntry): DataEntry => ({
            name: entry.name,
            base: fromTerm(entry.base),
          }),
        ),
      }
    case 'blank':
      return { kind: 'void' }
    case 'graft':
      return { kind: 'fuse', name: value.name }
    case 'number':
      return { kind: 'number', value: value.value }
    case 'decimal':
      return { kind: 'decimal', value: value.value }
    case 'text':
      return { kind: 'text', value: value.value }
    case 'flag':
      return { kind: 'flag', value: value.value }
  }
}

// a `code-defect` raised by the codec, as the error this module has always thrown. Anything else (a compressor's own
// failure) is not the codec's and goes on as it is
function caught(cause: unknown): unknown {
  const raised = cause as
    | {
        form?: unknown
        link?: { problem?: unknown; at?: unknown; reason?: unknown }
      }
    | undefined

  if (
    raised &&
    typeof raised === 'object' &&
    raised.form === 'code-defect' &&
    raised.link
  ) {
    return new TreeCodeError({
      name: raised.link.problem as CodeError['name'],
      message: String(raised.link.reason),
      at: Number(raised.link.at),
    })
  }

  return cause
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

const keepPlain = (plain: Uint8Array): Uint8Array => plain

// the canonical `tree/code` of one value, or of several (one frame each)
export function encodeTree(
  values: Data | Data[],
  options: EncodeOptions = {},
): Uint8Array {
  const items = (Array.isArray(values) ? values : [values]).map(toTerm)

  try {
    return encodeCode(
      items,
      Boolean(options.compress),
      options.compressAbove ?? 256,
      Boolean(options.end),
      options.compress ?? keepPlain,
    )
  } catch (cause) {
    throw caught(cause)
  }
}

// one frame, without a header: the unit a stream writer appends
export function encodeFrame(
  value: Data,
  options: EncodeOptions = {},
): Uint8Array {
  try {
    return encodeCodeFrame(
      toTerm(value),
      Boolean(options.compress),
      options.compressAbove ?? 256,
      options.compress ?? keepPlain,
    )
  } catch (cause) {
    throw caught(cause)
  }
}

export function encodeHeader(): Uint8Array {
  return encodeCodeHeader()
}

// ---- decoding ----

export type DecodeOptions = {
  decompress?: (packed: Uint8Array, size: number) => Uint8Array
  limits?: Partial<CodeLimits>
}

export type DecodeResult =
  | { ok: true; values: Data[] }
  | { ok: false; problem: CodeError }

const keepPacked = (packed: Uint8Array): Uint8Array => packed

// every value of a stream, or the first problem in it
export function decodeTree(
  input: Uint8Array,
  options: DecodeOptions = {},
): DecodeResult {
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
export function* readFrames(
  input: Uint8Array,
  options: DecodeOptions = {},
): Generator<Data> {
  const limits = { ...LIMITS, ...options.limits }
  const unpack = Boolean(options.decompress)
  const decompress = options.decompress ?? keepPacked

  let reader: ReturnType<typeof openCodeReader>

  try {
    reader = openCodeReader(input, limits.depth, limits.frame)
  } catch (cause) {
    throw caught(cause)
  }

  for (;;) {
    let value: Data

    try {
      if (!codeReaderMore(reader)) {
        return
      }

      value = fromTerm(readCodeFrame(reader, unpack, decompress))
    } catch (cause) {
      throw caught(cause)
    }

    yield value
  }
}
