// A DEFINITION'S HOLD KEY TEXT, KEPT (decision 102 of term/self-host/change/001-finish-self-host). check/hold-walk.tree
// `key-text` writes a statement's node-json for every task's memo key and for every definition that key reaches, again
// on every check of every unit, which was a quarter of a body-edit rebuild on @cluesurf/zone (item 0416's profile). Here
// each answer is kept by the statement's own native text, its `span` left out at every depth as hold-walk.tree
// `key-skip` leaves it out, so a definition met again (the same stub in the next unit, the same task on the next check)
// is never written twice.
//
// EXACT, NOT HASHED: the key is the whole text, never a digest, and it holds everything the statement holds that
// node-json can read (every field, a Map's and a Set's entries, a bigint, a number JSON cannot write, an absent value),
// so two statements with one key have one node-json. A value it cannot write exactly (a function, a symbol, a class
// instance, a cycle) answers no key, and that statement is written as before. Browser-safe: no import.
//
// The memo lives in the process beside the hold memo it serves (check/holds.ts), never in the store, and is emptied by
// `clearHoldKeyMemo` (holds.ts `clearHoldMemo`) and whenever the texts it keeps pass HOLD_KEY_MEMO_CHARS.

type KeyFound = { text: string; names: string[] }

// the most text the memo keeps, its keys and answers together, before it starts again empty
export const HOLD_KEY_MEMO_CHARS = 128 * 1024 * 1024

// a marker no statement's own key can be (the mill writes words), for the values JSON would lose or merge
const MARK = '\u0000'

class NotExact extends Error {}

const MARK_KEY = JSON.stringify(MARK)

// a field's name as JSON, written once: a program has few names and many fields (item 0757)
const quotedKeys = new Map<string, string>()

function quotedKey(key: string): string {
  let quoted = quotedKeys.get(key)

  if (quoted === undefined) {
    quoted = JSON.stringify(key)
    quotedKeys.set(key, quoted)
  }

  return quoted
}

// the text JSON.stringify writes with a replacer that marks what JSON would lose, written by hand since a replacer made
// this 2.1 ms of every keystroke (item 0757, test/check/hold-key-memo.ts). `span` is left out at every depth. A cycle
// overflows the stack, which `key` answers as no key, as JSON.stringify's own refusal was
function exactly(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'undefined':
      return `{${MARK_KEY}:"u"}`
    case 'bigint':
      return `{${MARK_KEY}:"b","v":"${value.toString()}"}`
    case 'number':
      if (Number.isFinite(value) && !Object.is(value, -0)) return String(value)
      return `{${MARK_KEY}:"n","v":"${Object.is(value, -0) ? '-0' : String(value)}"}`
    case 'function':
    case 'symbol':
      throw new NotExact()
    default:
  }

  if (value === null) return 'null'

  if (Array.isArray(value)) {
    let out = '['

    for (let at = 0; at < value.length; at++) {
      if (at > 0) out += ','
      out += exactly(value[at])
    }

    return `${out}]`
  }

  if (value instanceof Map) return `{${MARK_KEY}:"m","e":${exactly([...value.entries()])}}`
  if (value instanceof Set) return `{${MARK_KEY}:"s","v":${exactly([...value])}}`

  const proto = Object.getPrototypeOf(value)

  if (proto !== Object.prototype && proto !== null) throw new NotExact()

  let out = '{'
  let first = true
  const fields = value as Record<string, unknown>

  for (const key of Object.keys(fields)) {
    if (key === MARK) throw new NotExact()
    if (key === 'span') continue
    if (first) first = false
    else out += ','
    out += quotedKey(key)
    out += ':'
    out += exactly(fields[key])
  }

  return `${out}}`
}

const kept = new Map<string, KeyFound>()
let chars = 0

export const holdKeyMemo = {
  // the statement's whole native text, `''` when it cannot be written exactly
  key(statement: unknown): string {
    try {
      return exactly(statement)
    } catch {
      return ''
    }
  },
  has(key: string): boolean {
    return kept.has(key)
  },
  // a copy of the names, so no caller's list is another's
  get(key: string): KeyFound {
    const found = kept.get(key)!

    return { text: found.text, names: [...found.names] }
  },
  keep(key: string, found: KeyFound): boolean {
    const size = key.length + found.text.length

    if (chars + size > HOLD_KEY_MEMO_CHARS) clearHoldKeyMemo()

    kept.set(key, { text: found.text, names: [...found.names] })
    chars += size

    return true
  },
}

export function clearHoldKeyMemo(): void {
  kept.clear()
  chars = 0
}

// how many definitions the memo holds, for a test
export function holdKeyMemoSize(): number {
  return kept.size
}

;(globalThis as { __termHoldKeyMemo?: typeof holdKeyMemo }).__termHoldKeyMemo = holdKeyMemo
