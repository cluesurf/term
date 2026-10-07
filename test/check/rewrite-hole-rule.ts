// A rewrite rule whose left side is one of its own holes (check/elaborating-rewrite.tree `rewrite-with-lemmas`).
//
// Such a rule (a proven `x == mul(g(x), x)`, cited) matches EVERY term, so rewriting to a fixed point by it never ends,
// and a right side holding the hole twice doubles the term at each rewrite. `ac-rewrite-fix` rewrites 200 times between
// its AC steps, so one such rule took the whole heap (2^200 nodes): pair-elaborating died at its round 312 on
// 2026-10-07, and the original (check/elaborate.ts before the port) does the same. The fixed point now skips the rule,
// while one rewrite by it (`rewrite-once`, what `cite` uses to see a goal as an instance) still fires, and a rule with a
// real left side still rewrites to its fixed point. Each acceptance stands beside the refusal, so the suite cannot pass
// by refusing every rule.
//
// Run: npx tsx test/check/rewrite-hole-rule.ts

import * as rewriting from '@term/make/code/check/elaborating-rewrite'

let pass = 0
let fail = 0

function ok(name: string, good: boolean, detail = ''): void {
  if (good) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

type Term = { tag: string; [key: string]: unknown }
const v = (index: number): Term => ({ tag: 'var', index })
const c = (name: string): Term => ({ tag: 'const', name })
const bin = (op: string, a: Term, b: Term): Term => ({ tag: 'app', fun: { tag: 'app', fun: c(op), arg: a }, arg: b })
const rule = (binderCount: number, lhs: Term, rhs: Term, holes: number[] = []) => ({ binderCount, lhs, rhs, holes: new Map(holes.map(h => [h, true])) })
const size = (t: Term): number => (t.tag === 'app' ? 1 + size(t.fun as Term) + size(t.arg as Term) : t.tag === 'lam' ? 1 + size(t.body as Term) : 1)
const shown = (t: unknown): string => JSON.stringify(t)

// x -> mul(g(x, v2), add(zero, x)): the round-312 rule, the hole twice on the right
const doubling = rule(1, v(0), bin('mul', bin('g', v(0), v(2)), bin('add', c('zero'), v(0))))
const term = bin('mul', v(2), bin('add', c('one'), c('zero')))

const started = Date.now()
const fixed = rewriting.rewriteWithLemmas(term as never, [doubling] as never, 200) as unknown as Term
ok('a rule whose left side is a binder hole is skipped by the fixed point', shown(fixed) === shown(term), `size ${size(fixed)}`)
const ac = rewriting.acRewriteFix(term as never, new Map([['add', true]]) as never, [] as never, [doubling] as never, 20) as unknown as Term
ok('and by the AC fixed point, which rewrote 200 times between steps', size(ac) <= size(term) + 2, `size ${size(ac)}`)
ok('both in well under a second (the heap went before)', Date.now() - started < 1000, `${Date.now() - started} ms`)

// a set hole (a generalized induction hypothesis's non-recursive variable) as the whole left side, likewise
const setHole = rule(0, v(3), bin('add', v(3), v(3)), [3])
ok('a rule whose left side is a set hole is skipped too', shown(rewriting.rewriteWithLemmas(term as never, [setHole] as never, 50)) === shown(term))

// one rewrite by it still fires: `cite` sees `a == mul(g(a, v2), add(zero, a))` as an instance this way
const once = rewriting.rewriteOnce(term as never, doubling as never) as unknown as { form: string; value?: Term }
ok('one rewrite by a hole rule still fires', once.form === 'some' && size(once.value!) > size(term))

// a variable that is NOT a hole (a hypothesis `v5 == one`, binderCount 0) is a real left side, and still rewrites
const hypothesis = rule(0, v(5), c('one'))
const withFive = bin('add', v(5), v(5))
ok('a left side that is a free variable, no hole, still rewrites to its fixed point', shown(rewriting.rewriteWithLemmas(withFive as never, [hypothesis] as never, 10)) === shown(bin('add', c('one'), c('one'))))

// and a rule with a real left side beside the hole rule still reaches its fixed point: add(zero, y) -> y
const unit = rule(1, bin('add', c('zero'), v(0)), v(0))
const nested = bin('add', c('zero'), bin('add', c('zero'), c('two')))
ok('a real rule beside a hole rule rewrites to its fixed point', shown(rewriting.rewriteWithLemmas(nested as never, [doubling, unit] as never, 200)) === shown(c('two')))

console.log(`\nrewrite-hole-rule: ${pass} pass, ${fail} fail`)
process.exitCode = fail > 0 ? 1 : 0
