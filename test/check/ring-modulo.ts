// Ring identity MODULO hypotheses (ideal membership): prove a polynomial equality `L == R` given equational `have`
// hypotheses, by reducing `L - R` to zero in the ideal the hypotheses generate. This is the algebraic case of
// congruence under hypotheses -- it threads a hypothesis like `a*d = c*b` through an AC-normalized polynomial, which
// the literal-subterm rewrite cannot reach (rational well-definedness, conditional ring identities). Sound over the
// integers: see `ringEqualModulo` in ring.ts. The negative control is essential -- a NON-consequence must be rejected.
// Run: npx tsx test/check/ring-modulo.ts

import { compile } from '@cluesurf/make/code/compile/compile'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${detail}`)
  }
}

function compiles(source: string): boolean {
  return compile({ file: 'p.tree', text: source }).ok
}

const HEAD = `load @cluesurf/form/code/number/integer
  find integer
`

// the shared hypothesis `a*d = c*b` and a goal body, parameterised by the two trailing summands so the false control
// reuses the structure with a mismatch
function conditional(leftTail: string, rightTail: string): string {
  return `${HEAD}
rule conditional
  mark a, like integer
  mark b, like integer
  mark c, like integer
  mark d, like integer
  mark e, like integer
  mark f, like integer
  mark g, like integer
  have h
    call is-equal
      call multiply
        read a
        read d
      call multiply
        read c
        read b
  show hold
    call is-equal
      call add
        call multiply
          read e
          call multiply
            read a
            read d
        ${leftTail}
      call add
        call multiply
          read e
          call multiply
            read c
            read b
        ${rightTail}
  calm hold
`
}

// TRUE modulo the hypothesis: e*(a*d) + f = e*(c*b) + f. The hypothesis must thread inside the AC monomial e*a*d.
ok('conditional ring identity discharges', compiles(conditional('read f', 'read f')))

// FALSE: e*(a*d) + f = e*(c*b) + g is NOT a consequence of a*d = c*b. Must be rejected, or the prover is unsound.
ok(
  'non-consequence is rejected',
  !compiles(conditional('read f', 'read g')),
)

console.log(`\nring modulo hypotheses: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
