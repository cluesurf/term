// Tests for the vibe-computer base data types (balanced ternary). Run: pnpm call test/machine/data/run.ts

import {
  toTrits,
  fromTrits,
  tritString,
  fromTritString,
  negateTrits,
} from '@term/make/code/engine/data/trit'
import * as I from '@term/make/code/engine/data/integer'
import * as B from '@term/make/code/engine/data/boolean'
import * as F from '@term/make/code/engine/data/float'
import * as S from '@term/make/code/engine/data/string'
import * as A from '@term/make/code/engine/data/array'
import * as M from '@term/make/code/engine/data/map'

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`)
  }
}

// trit. Term since 2026-10-04: its exact integer is the stdlib's `big-integer`, `{ dock: bigint }` on TypeScript
{
  const big = (value: bigint) => ({ dock: value })
  let roundtrip = true

  for (let v = -200; v <= 200; v++)
    {if (fromTrits(toTrits(big(BigInt(v)))).dock !== BigInt(v)) {roundtrip = false}}

  check('trit: balanced-ternary roundtrip -200..200', roundtrip)
  check(
    'trit: tritString(5) = "+--"',
    tritString(big(5n)) === '+--',
    tritString(big(5n)),
  )
  check(
    'trit: fromTritString roundtrip',
    fromTritString(tritString(big(1234n))).dock === 1234n,
  )
  check(
    'trit: negate flips sign (free negation)',
    fromTrits(negateTrits(toTrits(big(42n)))).dock === -42n,
  )
}

// integer (multi-resolution). Term since 2026-10-04: `makeInteger` takes a big integer (`{ dock: bigint }`) and a
// resolution, `''` for the smallest that fits, and the operations are `addTernary` and so on
{
  const integer = (value: bigint | number, resolution = '') =>
    I.makeInteger({ dock: typeof value === 'bigint' ? value : BigInt(value) }, resolution)
  const a = integer(123),
    b = integer(-45)

  check('integer: add', I.toNumber(I.addTernary(a, b)) === 78)
  check('integer: multiply', I.toNumber(I.multiplyTernary(a, b)) === -5535)
  check(
    'integer: divide/remainder',
    I.toNumber(I.divideTernary(a, integer(10))) === 12 &&
      I.toNumber(I.remainderTernary(a, integer(10))) === 3,
  )
  check('integer: small fits tri8', integer(50).resolution === 'tri8')
  check(
    'integer: large promotes to big',
    I.addTernary(integer(3n ** 39n), integer(3n ** 39n)).resolution ===
      'big' || integer(3n ** 41n).resolution === 'big',
  )
  check(
    'integer: compare',
    I.compareTernary(a, b) === 1 &&
      I.compareTernary(b, a) === -1 &&
      I.compareTernary(a, a) === 0,
  )
  check(
    'integer: fixed resolution overflow throws',
    (() => {
      try {
        integer(10n ** 10n, 'tri8')

        return false
      } catch {
        return true
      }
    })(),
  )
}

// boolean (Kleene three-valued). Term since 2026-10-04: the constants are tasks and the connectives `-ternary`
{
  const [TRUE, FALSE, UNKNOWN] = [B.makeTrue(), B.makeFalse(), B.makeUnknown()]
  check(
    'boolean: and/or/not',
    B.andTernary(TRUE, FALSE) === FALSE &&
      B.orTernary(TRUE, FALSE) === TRUE &&
      B.notTernary(TRUE) === FALSE,
  )
  check(
    'boolean: unknown propagates',
    B.andTernary(TRUE, UNKNOWN) === UNKNOWN &&
      B.orTernary(TRUE, UNKNOWN) === TRUE,
  )
}

// float (balanced ternary)
{
  const x = F.fromNumber(3.5),
    y = F.fromNumber(1.25)

  check(
    'float: add ~ 4.75',
    Math.abs(F.toNumber(F.addTernary(x, y)) - 4.75) < 1e-6,
    String(F.toNumber(F.addTernary(x, y))),
  )
  check(
    'float: multiply ~ 4.375',
    Math.abs(F.toNumber(F.multiplyTernary(x, y)) - 4.375) < 1e-6,
  )
  check(
    'float: roundtrip',
    Math.abs(F.toNumber(F.fromNumber(2.71828)) - 2.71828) < 1e-4,
  )
}

// string (rope)
{
  let r = S.fromString('hello ')
  r = S.concat(r, S.fromString('hyperbolic world'))
  check('string: length', S.length(r) === 22, String(S.length(r)))
  check('string: charAt', S.charAt(r, 6) === 'h')
  check(
    'string: slice',
    S.toString(S.slice(r, 6, 16)) === 'hyperbolic',
    S.toString(S.slice(r, 6, 16)),
  )
  check(
    'string: toString roundtrip',
    S.toString(S.fromString('café 日本')) === 'café 日本',
  )
}

// array (persistent tree vector)
{
  let v = A.empty<number>()

  for (let i = 0; i < 100; i++) {v = A.push(v, i * i)}

  check('array: push + get', A.get(v, 12) === 144 && A.size(v) === 100)
  v = A.set(v, 12, -1)
  check('array: set', A.get(v, 12) === -1)
  check(
    'array: slice',
    A.toArray(A.slice(v, 0, 3)).join(',') === '0,1,4',
  )
  check(
    'array: map + reduce',
    A.reduce(
      A.map(v, x => (x < 0 ? 0 : x)),
      (a, b) => a + b,
      0,
    ) ===
      (() => {
        let s = 0

        for (let i = 0; i < 100; i++) {if (i !== 12) {s += i * i}}

        return s
      })(),
  )
}

// map (ternary trie). Term since 2026-10-04: a map is a value, each write answering the new one, and `get` is
// `lookup` with a fallback
{
  let m = M.makeMap<number>()
  m = M.set(m, 'alpha', 1)
  m = M.set(m, 'beta', 2)
  m = M.set(m, 'gamma', 3)
  check(
    'map: get/has',
    M.lookup(m, 'beta', -1) === 2 && M.has(m, 'gamma') && !M.has(m, 'delta'),
  )
  check(
    'map: overwrite keeps size',
    (() => {
      m = M.set(m, 'beta', 20)

      return M.size(m) === 3 && M.lookup(m, 'beta', -1) === 20
    })(),
  )
  check(
    'map: remove',
    M.has(m, 'alpha') && !M.has((m = M.remove(m, 'alpha')), 'alpha') && M.size(m) === 2,
  )
  check('map: keys', M.keys(m).sort().join(',') === 'beta,gamma')
}

console.log(`\ndata types: ${pass} pass, ${fail} fail`)
