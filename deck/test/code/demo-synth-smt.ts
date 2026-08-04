/**
 * Synthesis with the SMT solver in the loop: the result is proven for
 * ALL integers, and then emitted as real Seed and compiled. Run from
 * the seed install root (after `pnpm install`):
 *   npx tsx deck/test/code/demo-synth-smt.ts
 *
 * Spec in -> Z3-backed CEGIS (unbounded proof) -> emit Seed -> compile.
 * The strongest form of the loop: the synthesized code is correct for
 * every input, not merely over a bound, and it compiles.
 */

import { projectResolver } from '@term/call/code/make'
import { compile } from '@term/make/code/compile/compile'
import { makeSmt, type SymSpec } from './smt'
import { synthesizeSmt } from './synth-smt'
import { emitSeed } from './emit'
import { showExpr, type Spec } from './synthesize'

async function main(): Promise<void> {
  let z3
  try {
    z3 = await makeSmt()
  } catch {
    console.log('z3-solver not installed - run `pnpm install`, then re-run.')
    console.log('\nseed-verify synth-smt demo: skipped (no z3)')
    return
  }

  const ROOT = process.cwd()
  const resolve = projectResolver(ROOT, 'node', ROOT)

  let pass = 0
  let fail = 0
  function ok(name: string, cond: boolean, info = ''): void {
    if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
    else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
  }

  const cases: {
    taskName: string
    varCount: number
    names: string[]
    jsSpec: Spec
    symSpec: SymSpec
  }[] = [
    {
      taskName: 'find-max',
      varCount: 2,
      names: ['a', 'b'],
      jsSpec: ([a, b], out) => out >= a && out >= b && (out === a || out === b),
      symSpec: (vars, out, z3) => {
        const [a, b] = vars
        return z3.And(out.ge(a), out.ge(b), z3.Or(out.eq(a), out.eq(b)))
      },
    },
    {
      taskName: 'find-abs',
      varCount: 1,
      names: ['a'],
      jsSpec: ([a], out) => out >= 0 && (out === a || out === -a),
      symSpec: (vars, out, z3) => {
        const [a] = vars
        return z3.And(out.ge(z3.Int.val(0)), z3.Or(out.eq(a), out.eq(a.neg())))
      },
    },
  ]

  for (const c of cases) {
    // synthesize with Z3 in the loop -> proven for ALL integers
    const synth = await synthesizeSmt({
      varCount: c.varCount,
      jsSpec: c.jsSpec,
      symSpec: c.symSpec,
      z3,
    })
    ok(`${c.taskName}: synthesized + proven UNBOUNDED via Z3`,
      synth.ok,
      synth.ok ? `=> ${showExpr(synth.expr, c.names)} (${synth.counterexamples.length} Z3 counterexamples)` : synth.reason)

    if (synth.ok) {
      // emit as Seed and compile - the unbounded-proven code is real
      const source = emitSeed({ name: c.taskName, params: c.names, body: synth.expr })
      const compiled = compile({ file: `${c.taskName}.tree`, text: source }, { resolve })
      ok(`${c.taskName}: emitted Seed compiles`, compiled.ok,
        compiled.ok ? '' : (compiled.diagnostics || []).slice(0, 1).map(d => d.name).join())
    }
  }

  console.log(`\nseed-verify synth-smt demo: ${pass} pass, ${fail} fail`)
  if (fail > 0) process.exit(1)
}

main()
