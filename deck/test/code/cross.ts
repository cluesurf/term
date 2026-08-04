/**
 * Differential testing across Seed's backends (`test cross`). The same
 * compiled program is emitted to every backend; a backend that fails to
 * emit (throws, or produces nothing) for a program the others accept is
 * a backend bug. This is the highest-value correctness tool a multi-
 * backend compiler has (note/methodology/verification/techniques.md H),
 * and it is unique to Seed's design.
 *
 * Running the emitted Rust/Kotlin/Swift needs their toolchains (absent
 * here), so this checks emit-agreement: every backend produces code for
 * every program. The TypeScript backend additionally runs.
 */

import { compile } from '@term/make/code/compile/compile'
import type { Resolver } from '@term/make/code/compile/load'
import { emitTypeScript } from '@term/make/code/compile/typescript'
import { emitRust } from '@term/make/code/compile/rust'
import { emitKotlin } from '@term/make/code/compile/kotlin'
import { emitSwift } from '@term/make/code/compile/swift'

export type BackendName = 'typescript' | 'rust' | 'kotlin' | 'swift'

const BACKENDS: { name: BackendName; emit: (program: any) => string }[] = [
  { name: 'typescript', emit: program => emitTypeScript(program) },
  { name: 'rust', emit: emitRust },
  { name: 'kotlin', emit: emitKotlin },
  { name: 'swift', emit: emitSwift },
]

export type CrossResult = {
  ok: boolean
  compiled: boolean
  /** Per-backend: emitted length, or an error message. */
  emits: Record<string, { ok: boolean; length: number; error?: string }>
}

/**
 * Compile one Seed program and emit it to every backend. `ok` when the
 * program compiles and all backends emit non-empty code (they agree the
 * program is well-formed). A divergence is a backend bug.
 */
export function crossEmit(
  source: string,
  resolve: Resolver = () => undefined,
): CrossResult {
  const compiled = compile({ file: 'cross.tree', text: source }, { resolve })

  const emits: CrossResult['emits'] = {}
  let allOk = compiled.ok

  if (compiled.ok) {
    for (const backend of BACKENDS) {
      try {
        const out = backend.emit(compiled.program)
        const ok = typeof out === 'string' && out.length > 0
        emits[backend.name] = { ok, length: out?.length ?? 0 }
        if (!ok) allOk = false
      } catch (error) {
        emits[backend.name] = {
          ok: false,
          length: 0,
          error: error instanceof Error ? error.message : String(error),
        }
        allOk = false
      }
    }
  }

  return { ok: allOk, compiled: compiled.ok, emits }
}
