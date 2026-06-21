// Soundness + performance of the optimized Fourier-Motzkin prover (refine.ts): valid implications must prove, INVALID
// ones must NOT (the dedup / gcd-normalize / smart-order optimizations must never make it wrongly prove a false goal),
// and a deep chain must stay fast. Run: npx tsx test/check/refine-opt.ts
import { linear, atMost, atLeast, below, above, proves } from '@cluesurf/make/code/check/refine'
let pass = 0, fail = 0
const ok = (n: string, c: boolean) => { if (c) { pass++; console.log('ok   ', n) } else { fail++; console.log('FAIL ', n) } }
const V = (v: string) => linear({ [v]: 1 })
const N = (k: number) => linear({}, k)
ok('transitivity a<=b,b<=c => a<=c', proves([atMost(V('a'),V('b')), atMost(V('b'),V('c'))], atMost(V('a'),V('c'))))
ok('n>=1 => n>=0', proves([atLeast(V('n'),N(1))], atLeast(V('n'),N(0))))
ok('strict n>0 => n>=1 (integer)', proves([above(V('n'),N(0))], atLeast(V('n'),N(1))))
ok('a<=b => a+c<=b+c', proves([atMost(V('a'),V('b'))], atMost(linear({a:1,c:1}), linear({b:1,c:1}))))
ok('chain x0..x8 => x0<=x8', proves(Array.from({length:8},(_,i)=>atMost(V('x'+i),V('x'+(i+1)))), atMost(V('x0'),V('x8'))))
ok('2a<=2b => a<=b (gcd reduce)', proves([atMost(linear({a:2}),linear({b:2}))], atMost(V('a'),V('b'))))
ok('NOT: a<=b => b<=a', !proves([atMost(V('a'),V('b'))], atMost(V('b'),V('a'))))
ok('NOT: n>=0 => n>=1', !proves([atLeast(V('n'),N(0))], atLeast(V('n'),N(1))))
ok('NOT: a<=b,b<=c => a<c', !proves([atMost(V('a'),V('b')), atMost(V('b'),V('c'))], below(V('a'),V('c'))))
ok('NOT: {} => a<=b', !proves([], atMost(V('a'),V('b'))))
ok('NOT: a<=5 => a<=4', !proves([atMost(V('a'),N(5))], atMost(V('a'),N(4))))
const t0 = Date.now()
ok('stress: 20-var chain x0<=x20', proves(Array.from({length:20},(_,i)=>atMost(V('x'+i),V('x'+(i+1)))), atMost(V('x0'),V('x20'))))
console.log(`stress time: ${Date.now()-t0}ms`)
console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
