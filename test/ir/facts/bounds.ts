// The counted-loop bounds fact (ir/facts/bounds.ts), held both ways: the loops it must guard, and for every rule a loop
// it must NOT, because a wrong guard runs a copy of the loop with no bounds checks. And the TypeScript it drives: the
// guarded copy beside the checked one.
// Run: npx tsx test/ir/facts/bounds.ts

import { compile } from '@term/make/code/compile/compile'
import { boundedLoops, integerBounds } from '@term/make/code/ir/facts/bounds'
import type { LoopGuard } from '@term/make/code/ir/facts/bounds'
import { emitTypeScript } from '@term/make/code/compile/typescript'
import type { Program, Statement } from '@term/make/code/compile/node'

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

// every guard the fact gives the program's loops
function guards(text: string): { found: LoopGuard[]; program: Program } {
  const built = compile({ file: 'main.tree', text }, { optimize: false })

  if (!built.ok) {
    throw new Error(built.diagnostics.map(d => d.message).join(' | '))
  }

  const facts = boundedLoops(built.program)
  const found: LoopGuard[] = []
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) {
      return
    }

    if (Array.isArray(value)) {
      value.forEach(visit)

      return
    }

    const node = value as { form?: string }

    if (node.form === 'while' && facts.has(node as Statement)) {
      found.push(facts.get(node as Statement)!)
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'type' && key !== 'span') {
        visit(child)
      }
    }
  }

  visit(built.program)

  return { found, program: built.program }
}

const show = (g: LoopGuard[]): string =>
  JSON.stringify(g.map(x => x.checks.map(c => `${c.list}:${c.base ?? ''}${c.offset >= 0 ? '+' : ''}${c.offset}:${c.side}`)))

// 1. the in-place reversal: `low` up, `high` down, a swap through both
const flip = guards(`task flip
  take xs, like list, like number
  take k, like number
  save low, code 0
  save high, read k
  walk test
    hook test
      call is-below
        read low
        read high
    hook hold
      host t, read xs/{low}
      save xs/{low}, read xs/{high}
      save xs/{high}, read t
      save low
        call add
          read low
          code 1
      save high
        call subtract
          read high
          code 1
`)
ok('a reversal under low < high is guarded', flip.found.length === 1, show(flip.found))
ok(
  'its guard asks low >= 0 and high < xs.length, nothing more',
  show(flip.found) === JSON.stringify([['xs:low+0:low', 'xs:high+0:high', 'xs:low+1:low', 'xs:high+0:high'].filter((v, i, a) => a.indexOf(v) === i)]) ||
    (flip.found[0]?.checks.some(c => c.side === 'low' && c.base === 'low' && c.offset === 0) === true &&
      flip.found[0]?.checks.some(c => c.side === 'high' && c.base === 'high' && c.offset === 0) === true &&
      flip.found[0]?.checks.every(c => c.list === 'xs') === true),
  show(flip.found),
)

const ts = emitTypeScript(flip.program)
ok('TypeScript writes the guarded copy with no checks beside the checked one', /if \(low >= 0 && high < xs\.length/.test(ts) && /xs\[low\]!/.test(ts) && /__termReadPast/.test(ts), ts.split('\n').filter(l => /if \(|xs\[/.test(l)).join(' | '))

// 2. a copy loop over `i < n` with an alias `after = i + 1`
const copy = guards(`task shift
  take xs, like list, like number
  take n, like number
  save i, code 0
  walk test
    hook test
      call is-below
        read i
        read n
    hook hold
      host after
        call add
          read i
          code 1
      save xs/{i}, read xs/{after}
      save i
        call add
          read i
          code 1
`)
ok('a shift through `after = i + 1` under i < n is guarded', copy.found.length === 1, show(copy.found))
ok(
  'its highest index is n, the alias read at i + 1 = n - 1 + 1',
  copy.found[0]?.checks.some(c => c.side === 'high' && c.base === 'n' && c.offset === 0) === true,
  show(copy.found),
)

const loop = (body: string, cond = 'is-below'): string => `task each
  take xs, like list, like number
  take ys, like list, like number
  take n, like number
  take j, like number
  save i, code 0
  walk test
    hook test
      call ${cond}
        read i
        read n
    hook hold
${body}
`
const step = `      save i
        call add
          read i
          code 1`

// 3-8. what must NOT be guarded
ok('an index that is not the counter is NOT guarded', guards(loop(`      save xs/{j}, code 1\n${step}`)).found.length === 0)
ok('i <= n is NOT guarded', guards(loop(`      save xs/{i}, code 1\n${step}`, 'is-maximum')).found.length === 0)
ok(
  'a counter written twice is NOT guarded',
  guards(loop(`      save xs/{i}, code 1\n      save i\n        call add\n          read i\n          code 2\n${step}`)).found.length === 0,
)
ok('a read AFTER the step is NOT guarded', guards(loop(`${step}\n      save xs/{i}, code 1`)).found.length === 0)
ok('a list the loop rebinds is NOT guarded', guards(loop(`      save xs/{i}, code 1\n      save xs, read ys\n${step}`)).found.length === 0)
ok(
  'a loop that calls a task is NOT guarded (the call could change the length)',
  guards(`task helper
  take xs, like list, like number
  like number
  send back, code 0
${loop(`      save xs/{i}, code 1\n      host z\n        call helper\n          read xs\n${step}`).replace('task each', 'task each')}`).found.length === 0,
)

// 9. a call to a task that cannot reach a list (scalar parameters, no list inside) keeps the guard: spectral-norm's
// `a-value`, called in the innermost loop
ok(
  'a loop calling a scalar-only task IS guarded',
  guards(`task weight
  take a, like number
  take b, like number
  like number
  send back
    call add
      read a
      read b
${loop(`      save xs/{i}
        call weight
          read i
          read j
${step}`)}`).found.length === 1,
)

// 10. a native module's function with scalar arguments (`fmath.sqrt`, what `square-root` inlines to) holds no list:
// n-body's `energy` and `advance`. And a task that calls one is still a scalar task
const native = `dock load
  load <global:fmath>, name fmath

task root
  take a, like number
  like number
  send back
    call fmath/sqrt
      read a
`
ok(
  'a loop calling a native function with scalar arguments IS guarded',
  guards(`${native}
${loop(`      save xs/{i}
        call fmath/sqrt
          read j
${step}`)}`).found.length === 1,
)
ok(
  'a loop calling a task that only calls a native function IS guarded',
  guards(`${native}
${loop(`      save xs/{i}
        call root
          read j
${step}`)}`).found.length === 1,
)
ok(
  'a native call passed the list is NOT guarded',
  guards(`dock load
  load <global:fmath>, name fmath

${loop(`      save xs/{i}
        call fmath/sqrt
          read xs
${step}`)}`).found.length === 0,
)

// 11. the integer bound of a scalar task: the largest power of two below which no checked operation leaves the safe
// integers, by interval arithmetic. spectral-norm's `a-value` (i + j, then ij * (ij + 1) / 2 + i + 1) is safe below 2^25
const boundOf = (text: string): number | undefined => {
  const built = compile({ file: 'main.tree', text }, { optimize: false })

  if (!built.ok) {
    throw new Error(built.diagnostics.map(d => d.message).join(' | '))
  }

  return integerBounds(built.program).get('f')
}
const pairSum = `task f
  take i, like number
  take j, like number
  like number
  save ij
    call add
      read i
      read j
  send back
    call add
      call divide
        call multiply
          read ij
          call add
            read ij
            code 1
        code 2
      read i
`
ok('a-value\'s arithmetic is safe below 2^25', boundOf(pairSum) === 2 ** 25, String(boundOf(pairSum)))
ok(
  'a cube is safe only below a smaller bound',
  boundOf(`task f
  take i, like number
  like number
  send back
    call multiply
      call multiply
        read i
        read i
      read i
`) === 2 ** 17,
)
ok(
  'a division by an argument, which can be 0, has NO bound',
  boundOf(`task f
  take i, like number
  take j, like number
  like number
  send back
    call divide
      read i
      read j
`) === undefined,
)

// 12. a counted loop calling such a task with its counter and a name it never writes runs the unchecked copy behind
// `n <= L`; with any other argument the call keeps its checks
const caller = (args: string): LoopGuard[] =>
  guards(`${pairSum}
task g
  take xs, like list, like number
  take n, like number
  take k, like number
  save i, code 0
  walk test
    hook test
      call is-below
        read i
        read n
    hook hold
      save xs/{i}
        call f
${args}
      save i
        call add
          read i
          code 1
`).found
const counted = caller('          read i\n          read k')
ok(
  'the counter and an unwritten name are bounded: the call runs unchecked behind i >= 0, k in [0, 2^25), n <= 2^25',
  counted[0]?.fast?.length === 1 &&
    JSON.stringify(counted[0]?.limits) ===
      JSON.stringify([{ name: 'i', low: true }, { name: 'k', low: true }, { name: 'n', high: 2 ** 25 }, { name: 'k', high: 2 ** 25 - 1 }]),
  JSON.stringify(counted[0]?.limits),
)
ok('an argument of any other shape (i + 1) keeps the call checked', !caller('          call add\n            read i\n            code 1\n          read k')[0]?.fast)

console.log(`\nbounds: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
