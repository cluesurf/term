// Totality tests: strict positivity (hard error) and termination (warning). Run: npx tsx test/check/totality.ts

import { parse } from '@/code/parser/tree'
import { mill } from '@/code/compile/mill'
import { resolve } from '@/code/check/resolve'
import { check } from '@/code/check/infer'
import { checkTotality } from '@/code/check/totality'
import type { Program, Statement, Type } from '@/code/compile/node'
import type { Span } from '@/code/parser/diagnostic'

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

const SPAN: Span = { start: { line: 0, column: 0, offset: 0 }, end: { line: 0, column: 0, offset: 0 } }

function record(name: string, fieldType: Type): Program {
  const statement: Statement = {
    form: 'record-type',
    name,
    params: [],
    fields: [{ name: 'f', type: fieldType }],
    variants: [],
    span: SPAN,
  }
  return [statement]
}

function frontEnd(text: string): Program {
  const parsed = parse({ file: 't.tree', text })
  if (!parsed.ok) throw new Error('parse failed')
  const built = mill(parsed.tree, 't.tree')
  if (!built.ok) throw new Error('mill failed: ' + built.diagnostics.map((d) => d.message).join('; '))
  resolve(built.program, 't.tree')
  check(built.program, 't.tree')
  return built.program
}

// fib decreases its argument on both recursive calls
const FIB = `task fib
  take n, like number
  like number
  fork test
    hook test
      call is-below
        loan n
        mark 2
    hook hold
      back n
    hook miss
      back
        call add
          call fib
            call subtract
              loan n
              mark 1
          call fib
            call subtract
              loan n
              mark 2
`

// loops forever: the recursive call passes the argument unchanged
const LOOP = `task loop
  take n, like number
  like number
  back
    call loop
      loan n
`

// not recursive at all
const PLAIN = `task plus-one
  take n, like number
  like number
  back
    call add
      loan n
      mark 1
`

// mutual recursion with no cross-function descent argument: neither calls itself directly, so only the call graph
// reveals the cycle
const MUTUAL = `task ping
  take n, like number
  like number
  back
    call pong
      loan n

task pong
  take n, like number
  like number
  back
    call ping
      loan n
`

function main(): void {
  // ---- positivity ----
  // a self-reference to the left of an arrow (a parameter) is negative: rejected
  const negative: Type = { kind: 'function', params: [{ kind: 'named', name: 'bad' }], result: { kind: 'number' } }
  const negativeReport = checkTotality(record('bad', negative), 't.tree')
  ok('strict positivity rejects a negative self-occurrence', negativeReport.errors.some((d) => d.name === 'non-positive'), JSON.stringify(negativeReport.errors.map((d) => d.name)))

  // a self-reference only in the result (positive) is fine
  const positive: Type = { kind: 'function', params: [{ kind: 'number' }], result: { kind: 'named', name: 'good' } }
  const positiveReport = checkTotality(record('good', positive), 't.tree')
  ok('strict positivity accepts a positive self-occurrence', positiveReport.errors.length === 0, JSON.stringify(positiveReport.errors.map((d) => d.name)))

  // an ordinary first-order record is fine
  const plainRecord = checkTotality(record('point', { kind: 'number' }), 't.tree')
  ok('strict positivity accepts a first-order field', plainRecord.errors.length === 0)

  // ---- termination ----
  const fib = checkTotality(frontEnd(FIB), 't.tree')
  ok('termination accepts decreasing recursion (fibonacci)', fib.warnings.every((d) => d.name !== 'non-terminating'), JSON.stringify(fib.warnings.map((d) => d.message)))

  const loop = checkTotality(frontEnd(LOOP), 't.tree')
  ok('termination flags non-decreasing recursion', loop.warnings.some((d) => d.name === 'non-terminating'), JSON.stringify(loop.warnings.map((d) => d.name)))

  const plain = checkTotality(frontEnd(PLAIN), 't.tree')
  ok('termination is silent for non-recursive functions', plain.warnings.length === 0)

  const mutual = checkTotality(frontEnd(MUTUAL), 't.tree')
  ok('termination flags mutual recursion (via the call graph)', mutual.warnings.some((d) => d.name === 'non-terminating'), JSON.stringify(mutual.warnings.map((d) => d.message)))

  console.log(`\ntotality: ${pass} pass, ${fail} fail`)
}

main()
