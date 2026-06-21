// Sum-of-squares (PSD) soundness for nonNegativeDifference: quadratic inequalities that must prove, and indefinite /
// false ones that must NOT (soundness). Run: npx tsx test/check/sos.ts

import { nonNegativeDifference } from '@cluesurf/make/code/check/ring'
import type { Expression } from '@cluesurf/make/code/compile/node'
const S = { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } } as any
const i = (value: number): Expression => ({ form: 'integer', value, span: S } as any)
const v = (name: string): Expression => ({ form: 'variable', name, span: S } as any)
const bin = (op: string, left: Expression, right: Expression): Expression => ({ form: 'binary', op, left, right, span: S } as any)
const mul = (a: Expression, b: Expression) => bin('*', a, b)
const add = (a: Expression, b: Expression) => bin('+', a, b)
const sub = (a: Expression, b: Expression) => bin('-', a, b)
const a = v('a'), b = v('b'), c = v('c'), n = v('n')
let pass = 0, fail = 0
function ok(name: string, cond: boolean) { if (cond) { pass++; console.log('ok   ', name) } else { fail++; console.log('FAIL ', name) } }
// POSITIVE (must be provable >= 0)
ok('a^2 >= 0', nonNegativeDifference(mul(a,a), i(0)))
ok('a^2 + b^2 >= 2ab (AM-GM)', nonNegativeDifference(add(mul(a,a),mul(b,b)), mul(i(2),mul(a,b))))
ok('(a-b)^2 >= 0 expanded', nonNegativeDifference(add(sub(mul(a,a),mul(i(2),mul(a,b))),mul(b,b)), i(0)))
ok('n^2 - 2n + 1 >= 0', nonNegativeDifference(add(sub(mul(n,n),mul(i(2),n)),i(1)), i(0)))
ok('a^2+b^2+c^2 >= ab+bc+ca', nonNegativeDifference(add(add(mul(a,a),mul(b,b)),mul(c,c)), add(add(mul(a,b),mul(b,c)),mul(c,a))))
ok('2a^2+2b^2 >= (a+b)^2', nonNegativeDifference(add(mul(i(2),mul(a,a)),mul(i(2),mul(b,b))), mul(add(a,b),add(a,b))))
ok('5 >= 0 constant', nonNegativeDifference(i(5), i(0)))
// NEGATIVE (must NOT be provable -- soundness)
ok('NOT: ab >= 0 (indefinite)', !nonNegativeDifference(mul(a,b), i(0)))
ok('NOT: a^2 - 2b^2 >= 0', !nonNegativeDifference(sub(mul(a,a),mul(i(2),mul(b,b))), i(0)))
ok('NOT: a^2 >= 1', !nonNegativeDifference(mul(a,a), i(1)))
ok('NOT: a >= 0 (linear, not a square form)', !nonNegativeDifference(a, i(0)))
ok('NOT: 2ab >= a^2+2b^2', !nonNegativeDifference(mul(i(2),mul(a,b)), add(mul(a,a),mul(i(2),mul(b,b)))))
ok('NOT: -1 >= 0', !nonNegativeDifference(i(-1), i(0)))
ok('NOT: a^2+b^2 >= 3ab', !nonNegativeDifference(add(mul(a,a),mul(b,b)), mul(i(3),mul(a,b))))
console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
