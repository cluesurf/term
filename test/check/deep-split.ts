// DEEP CASE SPLITTING IN A MULTI-VARIABLE FOLD. `fold m, n` over two variables of a RECORD type whose fields are
// finite (a 2x2 matrix of residues) used to split each variable into its one constructor and leave the four fields
// standing as variables, so no law about the matrices could close. The fold now also splits every finite-typed field
// (check/elaborate.ts, `multiInduction` with `deep`), which is exhaustive case analysis and so sound. Each case has the
// control that would catch it going unsound: a false law over the same carrier must still be refused.
//
// Run: npx tsx test/check/deep-split.ts

import { compile } from '@term/make/code/compile/compile'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

function accepted(text: string): { accepted: boolean; errors: string } {
  const result = compile({ file: 'deep-split.tree', text })

  return {
    accepted: result.ok,
    errors: result.ok ? '' : result.diagnostics.map(d => d.name).join(','),
  }
}

// residues modulo two, and 2x2 matrices over them with the matrix product
const MATRICES = `form bit
  case off
  case on

task bit-sum
  take a, like bit
  take b, like bit
  like bit
  fork case, read a
    case off
      send back
        read b
    case on
      fork case, read b
        case off
          send back
            make on
        case on
          send back
            make off

task bit-product
  take a, like bit
  take b, like bit
  like bit
  fork case, read a
    case off
      send back
        make off
    case on
      send back
        read b

form square
  case grid
    link a, like bit
    link b, like bit
    link c, like bit
    link d, like bit

task row-column
  take a, like bit
  take b, like bit
  take c, like bit
  take d, like bit
  like bit
  send back
    call bit-sum
      call bit-product
        read a
        read b
      call bit-product
        read c
        read d

task compose
  take m, like square
  take n, like square
  like square
  fork case, read m
    case grid
      link ma
      link mb
      link mc
      link md
      fork case, read n
        case grid
          link na
          link nb
          link nc
          link nd
          send back
            make grid
              bind a
                call row-column
                  read ma
                  read na
                  read mb
                  read nc
              bind b
                call row-column
                  read ma
                  read nb
                  read mb
                  read nd
              bind c
                call row-column
                  read mc
                  read na
                  read md
                  read nc
              bind d
                call row-column
                  read mc
                  read nb
                  read md
                  read nd
`

{
  const out = accepted(`${MATRICES}
rule compose-is-associative
  mark m, like square
  mark n, like square
  mark p, like square
  show hold
    call is-equal
      call compose
        call compose
          read m
          read n
        read p
      call compose
        read m
        call compose
          read n
          read p
  fold m, n, p
`)
  ok('a law over record variables closes by splitting their fields', out.accepted, out.errors)
}

{
  const out = accepted(`${MATRICES}
rule compose-is-commutative
  mark m, like square
  mark n, like square
  show hold
    call is-equal
      call compose
        read m
        read n
      call compose
        read n
        read m
  fold m, n
`)
  ok('a false law over the same records is refused', !out.accepted, out.errors)
}

console.log(`\n${pass} passed, ${fail} failed`)

if (fail > 0) {
  process.exit(1)
}
