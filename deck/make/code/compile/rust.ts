// The Rust backend: emit the language as Rust. Parity with the other backends across every AST form: algebraic data
// types lower to native `enum`s and structs to `struct`s, with `match`. Strings are `String`, numbers `i64`. Native
// `dock` bindings become `use` + `module::fn` calls. Pure, browser-safe.
//
// THE FACE (self-hosting, item term-self-host-001-0065). The emitter is Term: the program pass, its tables and every
// analysis keyed by a node's place (compile/rust-program.tree), names and the spelling of a type
// (compile/rust-names.tree), the traits a form derives and the kinds of module binding (compile/rust-tables.tree), the
// declarations of forms, masks and instances (compile/rust-forms.tree), every expression and statement
// (compile/rust-emit.tree), and the module around them (compile/rust-assemble.tree). This face keeps the names callers
// import and hands the port a failure as a thrown `Error`. The wake goes to the port as the warnings made it,
// compile/program-warnings.tree's `wake-group` (decision 058).
// The emitter before the collapse is tmp/retired/make/compile/rust-face.ts.

import type { Program } from '@term/make/code/compile/node'
import type { WakeGroup } from '@term/make/code/compile/program-warnings'
import * as port from '@term/make/code/compile/rust-program'
import { textKeyReason as textKeyReasonOf } from '@term/make/code/compile/rust-names'

const fail = (reason: string): boolean => {
  throw new Error(reason)
}

// with `units`, each module's statements stay marked, for the caller to write one file per module
// (compile/unit-split.tree)
export function emitRust(handed: Program, options?: { wake?: WakeGroup[]; units?: boolean }): string {
  return port.emitRust(handed as never, options?.wake ?? [], Boolean(options?.units), fail)
}

// what the first pass recorded and which forms it boxes, for a test to assert (test/compile/rust-box.ts)
export function rustBoxing(program: Program): { cloned: string[]; generic: boolean; boxed: string[] } {
  return port.rustBoxingOf(program as never, fail)
}

// why a program's text-keyed maps keep `String` keys, or undefined when they take `TermKey`s (a test reads it)
export function textKeyReason(program: Program): string | undefined {
  const reason = textKeyReasonOf(program as never)

  return reason.form === 'some' ? reason.value : undefined
}
