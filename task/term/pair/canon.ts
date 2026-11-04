// Canonical text of a value, the first differing path of two values, and a unified diff of two texts. The pair
// runner (task/term/pair.ts) compares through these, so one definition of "equal" holds for every pair.
//
// The canonical text is JSON with the keys sorted at every level, written one leaf per line so a diff of two of
// them points at the leaf. It keeps apart what JSON.stringify folds together: `undefined` against an absent key,
// `undefined` and `NaN` and `Infinity` against `null`, `-0` against `0`, a bigint against a number, a Map or Set
// against an array, and an Error against a plain object. A Map and a Set keep their insertion order, because
// a port that changes it changes what a caller iterating it sees.

import { createHash } from 'node:crypto'

type Kind =
  | 'undefined'
  | 'null'
  | 'boolean'
  | 'number'
  | 'bigint'
  | 'string'
  | 'symbol'
  | 'function'
  | 'array'
  | 'bytes'
  | 'date'
  | 'map'
  | 'set'
  | 'error'
  | 'object'

const DEPTH = 200

function kindOf(value: unknown): Kind {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'

  switch (typeof value) {
    case 'boolean':
      return 'boolean'
    case 'number':
      return 'number'
    case 'bigint':
      return 'bigint'
    case 'string':
      return 'string'
    case 'symbol':
      return 'symbol'
    case 'function':
      return 'function'
  }

  if (Array.isArray(value)) return 'array'
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return 'bytes'
  if (value instanceof Date) return 'date'
  if (value instanceof Map) return 'map'
  if (value instanceof Set) return 'set'
  if (value instanceof Error) return 'error'

  return 'object'
}

export function bytesOf(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (typeof value === 'string') return new TextEncoder().encode(value)

  return new TextEncoder().encode(canon(value))
}

// keys by code unit order, never by locale
function keysOf(value: object): string[] {
  return Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function entriesOf(value: unknown, kind: Kind): unknown[] {
  if (kind === 'map') return [...(value as Map<unknown, unknown>)].map(entry => [...entry])
  if (kind === 'set') return [...(value as Set<unknown>)]

  return value as unknown[]
}

function write(value: unknown, depth: number, seen: object[]): string {
  const kind = kindOf(value)
  const pad = '  '.repeat(depth + 1)
  const end = '  '.repeat(depth)

  switch (kind) {
    case 'undefined':
      return 'undefined'
    case 'null':
      return 'null'
    case 'boolean':
      return String(value)
    case 'number':
      return Object.is(value, -0) ? '-0' : String(value)
    case 'bigint':
      return `${String(value)}n`
    case 'string':
      return JSON.stringify(value)
    case 'symbol':
      return String(value as symbol)
    case 'function':
      return `[Function ${(value as { name?: string }).name ?? ''}]`
    case 'date':
      return `Date(${Number.isNaN((value as Date).getTime()) ? 'invalid' : (value as Date).toISOString()})`
    case 'bytes': {
      const bytes = bytesOf(value)
      const rows: string[] = []

      for (let at = 0; at < bytes.length; at += 32) {
        rows.push(Buffer.from(bytes.subarray(at, at + 32)).toString('hex'))
      }

      return rows.length === 0
        ? 'bytes[]'
        : `bytes[\n${rows.map(row => `${pad}${row}`).join('\n')}\n${end}]`
    }
  }

  // a container: guard cycles and runaway depth
  if (depth > DEPTH || seen.includes(value as object)) return '[Circular]'

  const next = [...seen, value as object]

  if (kind === 'array' || kind === 'map' || kind === 'set') {
    const items = entriesOf(value, kind)
    const prefix = kind === 'array' ? '' : kind === 'map' ? 'Map ' : 'Set '

    if (items.length === 0) return `${prefix}[]`

    return `${prefix}[\n${items
      .map(item => `${pad}${write(item, depth + 1, next)}`)
      .join(',\n')}\n${end}]`
  }

  if (kind === 'error') {
    const error = value as Error
    const fields: Record<string, unknown> = {
      $error: error.constructor?.name ?? 'Error',
      message: error.message,
    }

    return write(fields, depth, seen)
  }

  const record = value as Record<string, unknown>
  const keys = keysOf(record)

  if (keys.length === 0) return '{}'

  return `{\n${keys
    .map(key => `${pad}${JSON.stringify(key)}: ${write(record[key], depth + 1, next)}`)
    .join(',\n')}\n${end}}`
}

export function canon(value: unknown): string {
  return write(value, 0, [])
}

function step(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`
}

// the first place two values differ, as `$.a[2].b`, or null when their canonical texts are equal
export function firstDiff(a: unknown, b: unknown, path = '$', depth = 0): string | null {
  const ka = kindOf(a)
  const kb = kindOf(b)

  if (ka !== kb) return path

  switch (ka) {
    case 'array':
    case 'map':
    case 'set': {
      const xs = entriesOf(a, ka)
      const ys = entriesOf(b, kb)

      if (depth > DEPTH) return path

      for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
        if (i >= xs.length || i >= ys.length) return `${path}[${i}]`

        const at = firstDiff(xs[i], ys[i], `${path}[${i}]`, depth + 1)

        if (at !== null) return at
      }

      return null
    }
    case 'error':
      return firstDiff(
        { $error: (a as Error).constructor?.name, message: (a as Error).message },
        { $error: (b as Error).constructor?.name, message: (b as Error).message },
        path,
        depth + 1,
      )
    case 'object': {
      if (depth > DEPTH) return path

      const x = a as Record<string, unknown>
      const y = b as Record<string, unknown>
      const keys = [...new Set([...keysOf(x), ...keysOf(y)])].sort((p, q) => (p < q ? -1 : p > q ? 1 : 0))

      for (const key of keys) {
        const hasX = Object.prototype.hasOwnProperty.call(x, key)
        const hasY = Object.prototype.hasOwnProperty.call(y, key)

        if (hasX !== hasY) return step(path, key)

        const at = firstDiff(x[key], y[key], step(path, key), depth + 1)

        if (at !== null) return at
      }

      return null
    }
    case 'bytes': {
      const x = bytesOf(a)
      const y = bytesOf(b)

      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if (i >= x.length || i >= y.length || x[i] !== y[i]) return `${path}[${i}]`
      }

      return null
    }
    default:
      return write(a, 0, []) === write(b, 0, []) ? null : path
  }
}

// Past this many characters on either side a diff holds each side's digest and the first differing path and line,
// never a line diff: one corpus file's whole answer (2.7 MB) made a hunk of some hundred thousand lines, and
// pushing it as arguments overflowed the stack before the verdict printed (traps.md T-0272).
export const DIFF_LIMIT = 1_000_000

// the longest line the large form shows of each side
const LINE_SHOWN = 2_000

function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function clipLine(line: string | undefined): string {
  if (line === undefined) return '(no line)'

  return line.length > LINE_SHOWN ? `${line.slice(0, LINE_SHOWN)}... (${line.length} chars)` : line
}

// the diff of two texts too large to match line by line: digests, sizes, the first differing path when the caller
// knows it, and the first differing line of each side
function largeDiff(
  left: string,
  right: string,
  leftName: string,
  rightName: string,
  path: string | undefined,
): string {
  const a = left.replace(/\n$/, '').split('\n')
  const b = right.replace(/\n$/, '').split('\n')
  let head = 0

  while (head < a.length && head < b.length && a[head] === b[head]) head++

  return [
    `--- ${leftName}`,
    `+++ ${rightName}`,
    `@@ too large to diff (over ${DIFF_LIMIT} chars) @@`,
    `${leftName}: ${a.length} lines, ${left.length} chars, sha256 ${digestOf(left)}`,
    `${rightName}: ${b.length} lines, ${right.length} chars, sha256 ${digestOf(right)}`,
    `first differing path: ${path ?? '(not given)'}`,
    `first differing line: ${head + 1}`,
    `-${clipLine(a[head])}`,
    `+${clipLine(b[head])}`,
    '',
  ].join('\n')
}

// A unified diff of two texts, three lines of context. Common lines at both ends are trimmed first, then the
// middle is matched by longest common subsequence, or replaced whole when it is too large to match. Two texts
// past DIFF_LIMIT get largeDiff, with `path` (the first differing JSON path) when the caller has it.
export function unifiedDiff(
  left: string,
  right: string,
  leftName: string,
  rightName: string,
  path?: string,
): string {
  if (left === right) return ''

  if (left.length > DIFF_LIMIT || right.length > DIFF_LIMIT) {
    return largeDiff(left, right, leftName, rightName, path)
  }

  const a = left.replace(/\n$/, '').split('\n')
  const b = right.replace(/\n$/, '').split('\n')

  let head = 0

  while (head < a.length && head < b.length && a[head] === b[head]) head++

  let tail = 0

  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }

  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  // edit script over the middle: ' ' kept, '-' only left, '+' only right
  const script: Array<[string, string]> = []

  if (midA.length * midB.length <= 4_000_000) {
    const width = midB.length + 1
    const table = new Uint32Array((midA.length + 1) * width)

    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        table[i * width + j] =
          midA[i] === midB[j]
            ? table[(i + 1) * width + j + 1]! + 1
            : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
      }
    }

    let i = 0
    let j = 0

    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        script.push([' ', midA[i]!])
        i++
        j++
      } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
        script.push(['-', midA[i]!])
        i++
      } else {
        script.push(['+', midB[j]!])
        j++
      }
    }

    while (i < midA.length) script.push(['-', midA[i++]!])
    while (j < midB.length) script.push(['+', midB[j++]!])
  } else {
    for (const line of midA) script.push(['-', line])
    for (const line of midB) script.push(['+', line])
  }

  const all: Array<[string, string]> = [
    ...a.slice(0, head).map((line): [string, string] => [' ', line]),
    ...script,
    ...a.slice(a.length - tail).map((line): [string, string] => [' ', line]),
  ]

  const context = 3
  const changed: number[] = []

  all.forEach(([mark], index) => {
    if (mark !== ' ') changed.push(index)
  })

  const out = [`--- ${leftName}`, `+++ ${rightName}`]
  let from = 0

  while (from < changed.length) {
    let to = from

    while (to + 1 < changed.length && changed[to + 1]! - changed[to]! <= context * 2 + 1) to++

    const start = Math.max(0, changed[from]! - context)
    const stop = Math.min(all.length - 1, changed[to]! + context)
    let leftStart = 1
    let rightStart = 1

    for (let k = 0; k < start; k++) {
      if (all[k]![0] !== '+') leftStart++
      if (all[k]![0] !== '-') rightStart++
    }

    let leftCount = 0
    let rightCount = 0
    const body: string[] = []

    for (let k = start; k <= stop; k++) {
      const [mark, line] = all[k]!

      if (mark !== '+') leftCount++
      if (mark !== '-') rightCount++

      body.push(`${mark}${line}`)
    }

    // one push per line: a spread of a long hunk overflows the argument stack (T-0272)
    out.push(`@@ -${leftStart},${leftCount} +${rightStart},${rightCount} @@`)

    for (const line of body) out.push(line)

    from = to + 1
  }

  return `${out.join('\n')}\n`
}
