// Tests for the vibe-computer base data types (balanced ternary). Run: pnpm call test/machine/data/run.ts

import {
  toTrits,
  fromTrits,
  tritString,
  fromTritString,
  negateTrits,
} from '@cluesurf/make/code/engine/data/trit'
import * as I from '@cluesurf/make/code/engine/data/integer'
import * as B from '@cluesurf/make/code/engine/data/boolean'
import * as F from '@cluesurf/make/code/engine/data/float'
import * as S from '@cluesurf/make/code/engine/data/string'
import * as A from '@cluesurf/make/code/engine/data/array'
import * as M from '@cluesurf/make/code/engine/data/map'

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

// trit
{
  let roundtrip = true

  for (let v = -200; v <= 200; v++)
    {if (fromTrits(toTrits(BigInt(v))) !== BigInt(v)) {roundtrip = false}}

  check('trit: balanced-ternary roundtrip -200..200', roundtrip)
  check(
    'trit: tritString(5) = "+--"',
    tritString(5n) === '+--',
    tritString(5n),
  )
  check(
    'trit: fromTritString roundtrip',
    fromTritString(tritString(1234n)) === 1234n,
  )
  check(
    'trit: negate flips sign (free negation)',
    fromTrits(negateTrits(toTrits(42n))) === -42n,
  )
}

// integer (multi-resolution)
{
  const a = I.integer(123),
    b = I.integer(-45)

  check('integer: add', I.toNumber(I.add(a, b)) === 78)
  check('integer: multiply', I.toNumber(I.multiply(a, b)) === -5535)
  check(
    'integer: divide/remainder',
    I.toNumber(I.divide(a, I.integer(10))) === 12 &&
      I.toNumber(I.remainder(a, I.integer(10))) === 3,
  )
  check('integer: small fits tri8', I.integer(50).resolution === 'tri8')
  check(
    'integer: large promotes to big',
    I.add(I.integer(3n ** 39n), I.integer(3n ** 39n)).resolution ===
      'big' || I.integer(3n ** 41n).resolution === 'big',
  )
  check(
    'integer: compare',
    I.compare(a, b) === 1 &&
      I.compare(b, a) === -1 &&
      I.compare(a, a) === 0,
  )
  check(
    'integer: fixed resolution overflow throws',
    (() => {
      try {
        I.integer(10n ** 10n, 'tri8')

        return false
      } catch {
        return true
      }
    })(),
  )
}

// boolean (Kleene three-valued)
{
  check(
    'boolean: and/or/not',
    B.and(B.TRUE, B.FALSE) === B.FALSE &&
      B.or(B.TRUE, B.FALSE) === B.TRUE &&
      B.not(B.TRUE) === B.FALSE,
  )
  check(
    'boolean: unknown propagates',
    B.and(B.TRUE, B.UNKNOWN) === B.UNKNOWN &&
      B.or(B.TRUE, B.UNKNOWN) === B.TRUE,
  )
}

// float (balanced ternary)
{
  const x = F.fromNumber(3.5),
    y = F.fromNumber(1.25)

  check(
    'float: add ~ 4.75',
    Math.abs(F.toNumber(F.add(x, y)) - 4.75) < 1e-6,
    String(F.toNumber(F.add(x, y))),
  )
  check(
    'float: multiply ~ 4.375',
    Math.abs(F.toNumber(F.multiply(x, y)) - 4.375) < 1e-6,
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

// map (ternary trie)
{
  const m = M.makeMap<number>()
  M.set(m, 'alpha', 1)
  M.set(m, 'beta', 2)
  M.set(m, 'gamma', 3)
  check(
    'map: get/has',
    M.get(m, 'beta') === 2 && M.has(m, 'gamma') && !M.has(m, 'delta'),
  )
  check(
    'map: overwrite keeps size',
    (() => {
      M.set(m, 'beta', 20)

      return M.size(m) === 3 && M.get(m, 'beta') === 20
    })(),
  )
  check(
    'map: remove',
    M.remove(m, 'alpha') && !M.has(m, 'alpha') && M.size(m) === 2,
  )
  check('map: keys', M.keys(m).sort().join(',') === 'beta,gamma')
}

console.log(`\ndata types: ${pass} pass, ${fail} fail`)
