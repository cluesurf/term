// The surface vocabulary: the words the language's own syntax reserves, and what each means to the compiler.
//
// It lives apart from `compile/mill.ts` because two readers need the same answer and one of them outlives the
// other: the hand-written mill, and the grammar-driven bridge that is replacing it (mint-bridge). A second copy
// of this table is a second language, and the disagreement would be silent.

import type { Type, BinaryOp } from '@term/make/code/compile/node'
import {
  numberType,
  floatType,
  booleanType,
  stringType,
  unitType,
  unknownType,
  dynamicType,
  bytesType,
} from '@term/make/code/compile/node'

// a type word that is not a form: the primitive it names. A `form` whose NAME is one of these registers no
// record-type, because the compiler uses the native representation; its methods are still desugared over the
// primitive kind (see the `form` branch of the mill).
export const TYPE_NAME: Record<string, Type> = {
  // `size`: a count or a length, the number every backend already has (94 stdlib signatures said `like size` and
  // no form declared it, so each backend was handed a `Size` it never defined)
  size: numberType(),
  u8: numberType(),
  u16: numberType(),
  u32: numberType(),
  u64: numberType(),
  u128: numberType(),
  i8: numberType(),
  i16: numberType(),
  i32: numberType(),
  i64: numberType(),
  i128: numberType(),
  'natural-number': numberType(),
  integer: numberType(),
  number: numberType(),
  // floating point: `decimal` / `float` and the sized floats are the distinct float type
  decimal: floatType(),
  float: floatType(),
  f32: floatType(),
  f64: floatType(),
  // the host's dynamic value (the opaque result of json parse)
  dynamic: dynamicType(),
  json: dynamicType(),
  // a raw byte buffer (Uint8Array / Vec<u8> / Data / ByteArray), the zero-copy currency for crypto and IO
  bytes: bytesType(),
  'byte-array': bytesType(),
  buffer: bytesType(),
  text: stringType(),
  boolean: booleanType(),
  void: unitType(),
  unit: unitType(),
  // bind's native primitives ARE seed's primitives (a JS string is seed's `string`, etc.): map them to the same
  // surface type so a seed value passes to a bind method param and vice versa, with no subtyping needed.
  'native-string': stringType(),
  'native-number': numberType(),
  'native-boolean': booleanType(),
  'native-bigint': numberType(),
  'native-void': unitType(),
  'native-null': unitType(),
  'native-undefined': unitType(),
  // `any` is the gradual type: consistent with everything (an opaque bind type, a callback union, etc.), and
  // `unknown` is the same value spelled from the holder's side: a slot that carries anything (a hive entry's record).
  // Both lower to the boxed dynamic on the native backends (Rc<dyn Any> / Any), never to a number.
  any: unknownType(),
  unknown: unknownType(),
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

// arithmetic the emitter lowers to a UNARY operation: `increment x` becomes `x + 1`. `not x` is `!x`, a word of the
// compiler's own like `and` and `or` beside it: it needed `load @term/base/boolean` where they did not, and without
// one `not(same)` failed as an unknown name whose note suggested `log` (guides: language/operators, 2026-10-04). The
// stdlib's `boolean/not` gives the same answer
export const UNARY_BUILTIN = new Set(['increment', 'decrement', 'not'])

// the `halt` arguments that are control flow rather than an exception to raise. An exception form may not take
// one of these names.
export const HALT_WORDS = new Set(['fork', 'flow', 'code', 'kink', 'take'])

// The tables asked by name, the shape the port (compile/surface.tree) exports, so a caller works against either. The
// constants above stay for compile/mill-legacy.ts, the parity gate's reference reader, which is not edited. `hasOwn`,
// where `in` also said yes to `toString` and `constructor`
export function isTypeName(name: string): boolean {
  return Object.hasOwn(TYPE_NAME, name)
}

export function typeOfWord(name: string): Type {
  return Object.hasOwn(TYPE_NAME, name) ? structuredClone(TYPE_NAME[name]!) : { kind: 'named', name }
}

export function isBinaryBuiltin(name: string): boolean {
  return Object.hasOwn(BINARY_BUILTIN, name)
}

// ask `isBinaryBuiltin` first: any other word answers `+`
export function binaryBuiltinOp(name: string): BinaryOp {
  return Object.hasOwn(BINARY_BUILTIN, name) ? BINARY_BUILTIN[name]! : '+'
}

export function isUnaryBuiltin(name: string): boolean {
  return UNARY_BUILTIN.has(name)
}

export function isHaltWord(name: string): boolean {
  return HALT_WORDS.has(name)
}

// Unescape a text literal's escape sequences: the delimiters (`\<` `\>` `\{` `\}`, kept in the chunk so the
// bracket is content and not a delimiter) and the standard characters (`\n` `\r` `\t` `\\`). This lets a native
// bind expression carry an arrow (`=>`) or a stray `>` without closing the `text <...>` literal, and lets a plain
// program build newlines and tabs with no native helper.
//
// `\e` IS THE ESCAPE CHARACTER (0x1B). Every ANSI colour sequence opens with it, and without it a Term program
// could not write a terminal colour at all: `tint`, the CLI's colour and the single most-docked TypeScript module
// in the converted CLI, could only call chalk, which is an npm package a native binary cannot have. One escape in
// the lexer is what lets that module be Term, and what `terminal` support needs on every backend.
//
// A text literal's VALUE is the unescaped one, everywhere, so this belongs beside the rest of the surface
// vocabulary rather than inside one of the two readers.
export function unescapeText(text: string): string {
  return text.replace(/\\([<>{}nrte\\])/g, (_, ch: string) =>
    ch === 'n'
      ? '\n'
      : ch === 'r'
        ? '\r'
        : ch === 't'
          ? '\t'
          : ch === 'e'
            ? '\u001b'
            : ch,
  )
}
