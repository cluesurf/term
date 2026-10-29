// The Swift backend: emit the language as idiomatic, type-static Swift. Parity with the TypeScript backend across
// every AST form. Algebraic data types lower to NATIVE generic enums (`enum Maybe<T> { case some(value: T); case none }`),
// `match` to native `if case let` pattern binding, and struct forms to `struct`s. Construction uses leading-dot syntax so
// Swift infers the type parameter from context. Pure, browser-safe. See note/project/term/archive/computation/plans/07-codegen.md.
//
// THE FACE (self-hosting, item term-self-host-001-0066). The emitter is Term: the program pass, the analyses keyed by a
// node's place, the preludes, the conformances and the wake chain (compile/swift-program.tree), the helpers that read
// no emitter state (compile/swift-names.tree), and every statement and expression (compile/swift-emit.tree). This face
// keeps the names callers import. The wake goes to the port as the warnings made it, compile/program-warnings.tree's
// `wake-group` (decision 058).
// The emitter before the collapse is tmp/retired/make/compile/swift-face.ts.

import type { Program } from '@term/make/code/compile/node'
import type { WakeGroup } from '@term/make/code/compile/program-warnings'
import * as port from '@term/make/code/compile/swift-program'

// The text operations by code point (note/project/term/stdlib/semantics.md), as the program's prelude writes them
export const SWIFT_TEXT: string = port.swiftTextText()

// with `units`, each module's statements stay marked, for the caller to write one file per module
// (compile/unit-split.tree)
export function emitSwift(written: Program, options?: { wake?: WakeGroup[]; units?: boolean }): string {
  return port.emitSwift(written as never, options?.wake ?? [], Boolean(options?.units))
}
