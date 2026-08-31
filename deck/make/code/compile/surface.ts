// The surface vocabulary: the words the language's own syntax reserves, and what each means to the compiler.
//
// It lives apart from `compile/mill.ts` because two readers need the same answer and one of them outlives the
// other: the hand-written mill, and the grammar-driven bridge that is replacing it (mint-bridge). A second copy
// of this table is a second language, and the disagreement would be silent.

import type { Type, BinaryOp } from '@term/make/code/compile/node'
import {
  NUMBER,
  FLOAT,
  BOOLEAN,
  STRING,
  UNIT,
  UNKNOWN,
  DYNAMIC,
  BYTES,
} from '@term/make/code/compile/node'

// a type word that is not a form: the primitive it names. A `form` whose NAME is one of these registers no
// record-type, because the compiler uses the native representation; its methods are still desugared over the
// primitive kind (see the `form` branch of the mill).
export const TYPE_NAME: Record<string, Type> = {
  // `size`: a count or a length, the number every backend already has (94 stdlib signatures said `like size` and
  // no form declared it, so each backend was handed a `Size` it never defined)
  size: NUMBER,
  u8: NUMBER,
  u16: NUMBER,
  u32: NUMBER,
  u64: NUMBER,
  u128: NUMBER,
  i8: NUMBER,
  i16: NUMBER,
  i32: NUMBER,
  i64: NUMBER,
  i128: NUMBER,
  'natural-number': NUMBER,
  integer: NUMBER,
  number: NUMBER,
  // floating point: `decimal` / `float` and the sized floats are the distinct float type
  decimal: FLOAT,
  float: FLOAT,
  f32: FLOAT,
  f64: FLOAT,
  // the host's dynamic value (the opaque result of json parse)
  dynamic: DYNAMIC,
  json: DYNAMIC,
  // a raw byte buffer (Uint8Array / Vec<u8> / Data / ByteArray), the zero-copy currency for crypto and IO
  bytes: BYTES,
  'byte-array': BYTES,
  buffer: BYTES,
  text: STRING,
  boolean: BOOLEAN,
  void: UNIT,
  unit: UNIT,
  // bind's native primitives ARE seed's primitives (a JS string is seed's `string`, etc.): map them to the same
  // surface type so a seed value passes to a bind method param and vice versa, with no subtyping needed.
  'native-string': STRING,
  'native-number': NUMBER,
  'native-boolean': BOOLEAN,
  'native-bigint': NUMBER,
  'native-void': UNIT,
  'native-null': UNIT,
  'native-undefined': UNIT,
  // `any` is the gradual type: consistent with everything (an opaque bind type, a callback union, etc.), and
  // `unknown` is the same value spelled from the holder's side: a slot that carries anything (a hive entry's record).
  // Both lower to the boxed dynamic on the native backends (Rc<dyn Any> / Any), never to a number.
  any: UNKNOWN,
  unknown: UNKNOWN,
}

// arithmetic and comparison the emitter lowers to a BINARY operation. These have no definition to bind to and are
// never imported, so both readers have to know them by name.
export const BINARY_BUILTIN: Record<string, BinaryOp> = {
  add: '+',
  subtract: '-',
  multiply: '*',
  divide: '/',
  modulo: '%',
  'is-above': '>',
  'is-below': '<',
  'is-equal': '==',
  'is-unequal': '!=',
  'is-minimum': '>=',
  'is-maximum': '<=',
  and: '&&',
  or: '||',
}

// arithmetic the emitter lowers to a UNARY operation: `increment x` becomes `x + 1`.
export const UNARY_BUILTIN = new Set(['increment', 'decrement'])

// the `halt` arguments that are control flow rather than an exception to raise. An exception form may not take
// one of these names.
export const HALT_WORDS = new Set(['fork', 'flow', 'code', 'kink', 'take'])

// Unescape a text literal's escape sequences: the delimiters (`\<` `\>` `\{` `\}`, kept in the chunk so the
// bracket is content and not a delimiter) and the standard characters (`\n` `\r` `\t` `\\`). This lets a native
// bind expression carry an arrow (`=>`) or a stray `>` without closing the `text <...>` literal, and lets a plain
// program build newlines and tabs with no native helper.
//
// A text literal's VALUE is the unescaped one, everywhere, so this belongs beside the rest of the surface
// vocabulary rather than inside one of the two readers.
export function unescapeText(text: string): string {
  return text.replace(/\\([<>{}nrt\\])/g, (_, ch: string) =>
    ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch,
  )
}
