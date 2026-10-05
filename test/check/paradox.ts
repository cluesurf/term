// K0: the paradoxes of an impredicative bottom universe, written out and refused (math-port-0010).
// Run: npx tsx test/check/paradox.ts
//
// `Type 0` is impredicative (judge.ts `piLevel`) and a form gets a LARGE eliminator `matchType__T` into `Type 1`
// (elaborate.ts). Each is consistent alone. Together, for a form whose constructor takes a TYPE, they prove false:
// the constructor `wrap : Type0 -> code` and the decoder `el (wrap t) = t` make `Type 0` a retract of `code`, a type
// that itself lives in `Type 0`. Hurkens' paradox then goes through on codes. This is Coquand's observation, and the
// reason Rocq refuses strong elimination of a LARGE inductive in an impredicative sort.
//
// The suite has three parts, so it cannot pass by refusing everything:
//   1. Hurkens over the bare kernel, with `*` = Type0 and the kinds one universe up. REFUSED, by predicativity above
//      the bottom: the paradox's `U` lives one universe above where `sigma` must instantiate it.
//   2. Hurkens over the signature a large form WOULD get. CHECKS, closing `(A : Type0) -> A`. This is the witness that
//      the signature is inconsistent, written against the kernel directly so that no elaborator change can hide it.
//   3. The elaborator. A form with a field typed `type` gets no large eliminator, so the decoder of part 2 cannot be
//      written and its computing equation is refused. A SMALL form keeps its large eliminator: an enum decodes into
//      `type`, and an induction-recursion universe still computes.

import type { Context, Term } from '@term/make/code/check/judge'
import {
  check,
  defineConstant,
  emptyContext,
  evaluate,
  litLevel,
  resetDefinitions,
  resetMetas,
} from '@term/make/code/check/judge'
import { compile } from '@term/make/code/compile/compile'

let pass = 0
let fail = 0

function ok(name: string, good: boolean, detail = ''): void {
  if (good) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${detail}`)
  }
}

// ---- named terms, converted to de Bruijn indices, so a page of lambda terms stays readable ----

type Named =
  | { k: 'var'; name: string }
  | { k: 'const'; name: string }
  | { k: 'type'; level: number }
  | { k: 'pi'; name: string; domain: Named; codomain: Named }
  | { k: 'lam'; name: string; body: Named }
  | { k: 'app'; fun: Named; arg: Named }
  | { k: 'ann'; term: Named; type: Named }

const v = (name: string): Named => ({ k: 'var', name })
const c = (name: string): Named => ({ k: 'const', name })
const ty = (level: number): Named => ({ k: 'type', level })
const pi = (name: string, domain: Named, codomain: Named): Named => ({ k: 'pi', name, domain, codomain })
const arrow = (domain: Named, codomain: Named): Named => pi('_', domain, codomain)
const lam = (name: string, body: Named): Named => ({ k: 'lam', name, body })
const ann = (term: Named, type: Named): Named => ({ k: 'ann', term, type })

function app(fun: Named, ...args: Named[]): Named {
  return args.reduce<Named>((f, arg) => ({ k: 'app', fun: f, arg }), fun)
}

// substitute `value` for the free `name` in `term`. The proof below never shadows a name it substitutes into, so a
// plain replacement that stops at a rebinding is enough
function substitute(term: Named, name: string, value: Named): Named {
  switch (term.k) {
    case 'var':
      return term.name === name ? value : term
    case 'const':
    case 'type':
      return term
    case 'pi':
      return {
        ...term,
        domain: substitute(term.domain, name, value),
        codomain: term.name === name ? term.codomain : substitute(term.codomain, name, value),
      }
    case 'lam':
      return term.name === name ? term : { ...term, body: substitute(term.body, name, value) }
    case 'app':
      return { k: 'app', fun: substitute(term.fun, name, value), arg: substitute(term.arg, name, value) }
    case 'ann':
      return { k: 'ann', term: substitute(term.term, name, value), type: substitute(term.type, name, value) }
  }
}

// a predicate applied to an argument, beta-reduced when the predicate is a lambda, since the kernel infers no bare
// function in head position
function at(p: Named, x: Named): Named {
  return p.k === 'lam' ? substitute(p.body, p.name, x) : app(p, x)
}

function toTerm(term: Named, scope: string[] = []): Term {
  switch (term.k) {
    case 'var': {
      const index = scope.indexOf(term.name)

      if (index < 0) {
        throw new Error(`unbound ${term.name}`)
      }

      return { tag: 'var', index }
    }
    case 'const':
      return { tag: 'const', name: term.name }
    case 'type':
      return { tag: 'type', level: litLevel(term.level) }
    case 'pi':
      return {
        tag: 'pi',
        mult: 'many',
        domain: toTerm(term.domain, scope),
        codomain: toTerm(term.codomain, [term.name, ...scope]),
      }
    case 'lam':
      return { tag: 'lam', body: toTerm(term.body, [term.name, ...scope]) }
    case 'app':
      return { tag: 'app', fun: toTerm(term.fun, scope), arg: toTerm(term.arg, scope) }
    case 'ann':
      return { tag: 'ann', term: toTerm(term.term, scope), type: toTerm(term.type, scope) }
  }
}

// a signature built one definition at a time: each body is checked against its type in the context of the ones
// before it, then made transparent, exactly as a file of definitions would be
type Signature = { context: Context; error: string | null }

function signature(): Signature {
  resetDefinitions()
  resetMetas()

  return { context: { ...emptyContext, globals: new Map() }, error: null }
}

function postulate(sig: Signature, name: string, type: Named): void {
  sig.context.globals.set(name, evaluate([], toTerm(type)))
}

// a definition: checked when `typed`, else a COMPUTING RULE registered as the elaborator registers one (untyped, the
// way `enumDefs` are), which is what makes `matchType Q b (wrap t)` reduce to `b t`
function define(sig: Signature, name: string, type: Named, body: Named, typed = true): void {
  if (sig.error) {
    return
  }

  const typeValue = evaluate([], toTerm(type))

  if (typed) {
    try {
      check(sig.context, toTerm(body), typeValue)
    } catch (error) {
      sig.error = `${name}: ${error instanceof Error ? error.message : String(error)}`

      return
    }
  }

  sig.context.globals.set(name, typeValue)
  defineConstant(name, evaluate([], toTerm(body)))
}

// ---- Hurkens' paradox (A. J. C. Hurkens, "A simplification of Girard's paradox", TLCA 1995) ----
// Parameterized by what a "proposition" is (`prop`, a type), how one is read as a type (`holds`), how a type is
// packed back into one (`pack`), and the universe the kinds live in (`kind`). The proof term is the one in Rocq's
// `Coq.Logic.Hurkens`, with the conversions it relies on spelled out as ascriptions, since this kernel's `check`
// does not unfold a definition to find a function type.
type Logic = {
  prop: Named
  holds: (p: Named) => Named
  pack: (a: Named) => Named
  kind: Named
  // the universe U is declared in: Type0 only when the kinds are in Type0 and propositions are codes in Type0
  home: number
}

function hurkens(sig: Signature, L: Logic): void {
  const P1 = (x: Named): Named => arrow(x, L.prop)
  const P2 = (x: Named): Named => arrow(P1(x), L.prop)

  // U := (X : kind) -> (P2 X -> X) -> P2 X
  // U is used INLINE (a notation, as in Rocq's file), since `check` meets it where a Pi is wanted. The definition is
  // only the test of where it lives
  const U = pi('X', L.kind, arrow(arrow(P2(v('X')), v('X')), P2(v('X'))))

  define(sig, 'U', ty(L.home), U)

  // tau t X f p := t (\x. p (f (x X f)))
  define(
    sig,
    'tau',
    arrow(P2(U), U),
    lam('t', lam('X', lam('f', lam('p', app(v('t'), lam('x', app(v('p'), app(v('f'), app(v('x'), v('X'), v('f')))))))))),
  )

  // sigma s := s U tau
  define(sig, 'sigma', arrow(U, P2(U)), lam('s', app(v('s'), U, c('tau'))))

  const tau = (t: Named): Named => app(c('tau'), t)
  const sigma = (s: Named): Named => app(c('sigma'), s)
  const bot: Named = pi('A', ty(0), v('A'))
  const neg = (a: Named): Named => arrow(a, bot)

  // the claim Delta y denies: every p that sigma y holds of, holds of tau (sigma y)
  const deltaClaim = (y: Named): Named =>
    pi('p', P1(U), arrow(L.holds(app(sigma(y), v('p'))), L.holds(app(v('p'), tau(sigma(y))))))

  define(sig, 'Delta', P1(U), lam('y', L.pack(neg(deltaClaim(v('y'))))))

  // Omega := tau (\p. forall x, sigma x p -> p x)
  const inductive = (p: Named): Named => pi('x', U, arrow(L.holds(app(sigma(v('x')), p)), L.holds(at(p, v('x')))))

  define(sig, 'Omega', U, tau(lam('p', L.pack(inductive(v('p'))))))

  const Omega = c('Omega')
  const Delta = c('Delta')
  // the predicate p shifted along tau . sigma
  const shift = (p: Named): Named => lam('y', app(p, tau(sigma(v('y')))))
  const lemma0Type: Named = pi('p', P1(U), arrow(inductive(v('p')), L.holds(app(v('p'), Omega))))

  // lemma0 p h := h Omega (\x. h (tau (sigma x)))
  define(
    sig,
    'lemma0',
    lemma0Type,
    lam(
      'p',
      lam(
        'h',
        app(
          ann(app(v('h'), Omega), arrow(inductive(shift(v('p'))), L.holds(app(v('p'), Omega)))),
          lam('x', app(v('h'), tau(sigma(v('x'))))),
        ),
      ),
    ),
  )

  // lemma h0 := h0 Delta (\x h2 h3. h3 Delta h2 (\p. h3 (shift p))) (\p. h0 (shift p))
  const inner = lam(
    'x',
    lam(
      'h2',
      lam(
        'h3',
        app(
          ann(app(v('h3'), Delta, v('h2')), neg(deltaClaim(tau(sigma(v('x')))))),
          lam('p', app(v('h3'), shift(v('p')))),
        ),
      ),
    ),
  )

  define(
    sig,
    'lemma',
    neg(lemma0Type),
    lam(
      'h0',
      app(
        ann(
          app(ann(app(v('h0'), Delta), arrow(pi('x', U, arrow(L.holds(app(sigma(v('x')), Delta)), neg(deltaClaim(v('x'))))), L.holds(app(Delta, Omega)))), inner),
          neg(deltaClaim(Omega)),
        ),
        lam('p', app(v('h0'), shift(v('p')))),
      ),
    ),
  )

  define(sig, 'paradox', bot, app(c('lemma'), c('lemma0')))
}

// ---- 1. the bare kernel: propositions are Type0 itself, the kinds live in Type1. Refused. ----
{
  const sig = signature()

  hurkens(sig, { prop: ty(0), holds: p => p, pack: a => a, kind: ty(1), home: 2 })
  ok(
    'Hurkens over the bare kernel (kinds in Type1) is refused',
    sig.error !== null,
    'the paradox checked: the kernel proves (A : Type0) -> A',
  )
  // the refusal must be the universe, at `sigma` instantiating X := U, and nowhere earlier: a typo in the proof term
  // would also be "refused" and prove nothing about the kernel
  ok(
    'and it is refused at sigma, where U : Type2 does not fit X : Type1',
    sig.error?.startsWith('sigma:') === true,
    `refused at: ${sig.error}`,
  )
}

// the same with the kinds in Type0: P2 X is then a Pi into Type1, so U lands in Type1 and is still too big for X.
{
  const sig = signature()

  hurkens(sig, { prop: ty(0), holds: p => p, pack: a => a, kind: ty(0), home: 0 })
  ok(
    'Hurkens with the kinds in Type0 is refused (U : Type1, predicative above the bottom)',
    sig.error?.startsWith('U:') === true,
    `refused at: ${sig.error}`,
  )
}

// ---- 2. the signature a LARGE form would get: Type0 a retract of code : Type0. Checks. ----
{
  const sig = signature()

  postulate(sig, 'code', ty(0))
  // the constructor and the large eliminator, with the computing rules the elaborator registers for them
  define(sig, 'wrap', arrow(ty(0), c('code')), lam('t', lam('Q', lam('b', app(v('b'), v('t'))))), false)
  define(
    sig,
    'matchType',
    pi('Q', arrow(c('code'), ty(1)), arrow(pi('t', ty(0), app(v('Q'), app(c('wrap'), v('t')))), pi('x', c('code'), app(v('Q'), v('x'))))),
    lam('Q', lam('b', lam('x', app(v('x'), v('Q'), v('b'))))),
    false,
  )
  // the decoder, CHECKED: el x := matchType (\_. Type0) (\t. t) x, so el (wrap t) computes to t
  define(
    sig,
    'el',
    arrow(c('code'), ty(0)),
    lam('x', app(c('matchType'), lam('_', ty(0)), lam('t', v('t')), v('x'))),
  )

  hurkens(sig, {
    prop: c('code'),
    holds: p => app(c('el'), p),
    pack: a => app(c('wrap'), a),
    kind: ty(0),
    home: 0,
  })

  ok(
    'Hurkens over a large form checks: the retract proves (A : Type0) -> A',
    sig.error === null && sig.context.globals.has('paradox'),
    `expected the witness to check, refused at: ${sig.error}`,
  )
}

// ---- 3. the elaborator refuses the large eliminator, and keeps the small ones ----

function compiles(text: string): { ok: boolean; codes: string; large: boolean } {
  const result = compile({ file: 'p.tree', text })
  const messages = result.ok ? [] : result.diagnostics.map(d => `${d.name}: ${d.message}`)

  return {
    ok: result.ok,
    codes: messages.join(' | '),
    // refused for the RIGHT reason: the large-form refusal, not a typo in the probe
    large: messages.some(m => m.includes('is large')),
  }
}

const TYPES = `form nat
  case zero
  case succ
    link prior, like nat

form bool
  case true
  case false
`

const RETRACT = `${TYPES}
form code
  case wrap
    link t, like type

task el
  take c, like code
  like type
  fork case, read c
    case wrap
      link t
      send back
        read t
`

// a rule that the decoding `left` (a call, stacked at six spaces) computes to the type `right`
const decodes = (left: string, right: string): string => `
rule decodes
  show hold
    call is-equal
${left}
      read ${right}
  calm hold
`

const EL_WRAP_NAT = `      call el
        make wrap
          bind t
            read nat`

{
  const result = compiles(`${RETRACT}${decodes(EL_WRAP_NAT, 'nat')}`)

  ok(
    'a form with a field typed `type` gets no large eliminator: el (wrap nat) == nat is refused',
    !result.ok && result.large,
    result.ok ? 'el (wrap nat) == nat checked, so Type0 is a retract of code and part 2 applies' : result.codes,
  )
}

{
  const result = compiles(`${RETRACT}${decodes(EL_WRAP_NAT, 'bool')}`)

  ok('control: el (wrap nat) == bool is refused', !result.ok)
}

// a field typed a FUNCTION into `type` is large too: it carries a family of types, and a decoder recovers each
{
  const result = compiles(`${TYPES}
form family
  case pack
    link f
      like task
        take n, like nat
        like type

task at-zero
  take x, like family
  like type
  fork case, read x
    case pack
      link f
      send back
        call f
          make zero
${decodes(`      call at-zero
        make pack
          bind f
            read the-nat`, 'nat')}
task the-nat
  take n, like nat
  like type
  send back
    read nat
`)

  ok('a field typed nat -> type is large: its decoder is refused', !result.ok && result.large, result.codes)
}

// the SMALL forms keep the large eliminator. An enum decodes into `type` (Rocq allows strong elimination of a small
// inductive in impredicative Set), and so does a universe of codes whose constructors carry codes, not types.
{
  const result = compiles(`${TYPES}
form flag
  case on
  case off

task meaning
  take x, like flag
  like type
  fork case, read x
    case on
      send back
        read nat
    case off
      send back
        read bool
${decodes(`      call meaning
        make on`, 'nat')}`)

  ok('small: an enum still decodes into type (meaning on == nat)', result.ok, result.codes)
}

{
  const result = compiles(`${TYPES}
form univ
  case natcode
  case listcode
    link elem, like univ

task el
  take u, like univ
  like type
  fork case, read u
    case natcode
      send back
        read nat
    case listcode
      link elem
      send back
        call el
          read elem
${decodes(`      call el
        make listcode
          bind elem
            make natcode`, 'nat')}`)

  ok('small: a recursive universe of codes still decodes (el (listcode natcode) == nat)', result.ok, result.codes)
}

// ---- 4. proof irrelevance holds for a truncation's constructor at its own arity, and nowhere past it ----
// `mark prop` makes any two `wrap x` equal. The eliminator's computing rule applies `wrap x` to a motive and branches,
// and then the LAST argument is a branch: `out1 (wrap true)` (branch \v. true) and `out2 (wrap true)` (branch \v. false)
// were convertible until 2026-10-05, though in every model of the eliminator they are true and false.
const TRUNCATION = `${TYPES}
form trunc
  mark prop
  case wrap
    link v, like bool

task out1
  take t, like trunc
  like bool
  fork case, read t
    case wrap
      send back
        make true

task out2
  take t, like trunc
  like bool
  fork case, read t
    case wrap
      send back
        make false
`

// `make wrap / bind v / make <v>`, its first line indented `at` spaces
const wrapped = (v: string, at = 6): string =>
  [`make wrap`, `  bind v`, `    make ${v}`].map(line => ' '.repeat(at) + line).join('\n')

{
  const result = compiles(`${TRUNCATION}
rule irrelevant
  show hold
    call is-equal
${wrapped('true')}
${wrapped('false')}
  calm hold
`)

  ok('a truncation is irrelevant: wrap true == wrap false', result.ok, result.codes)
}

{
  const result = compiles(`${TRUNCATION}
rule past-the-arity
  show hold
    call is-equal
      call out1
${wrapped('true', 8)}
      call out2
${wrapped('true', 8)}
  calm hold
`)

  ok(
    'and only at its arity: out1 (wrap true) == out2 (wrap true) is refused',
    !result.ok && result.codes.includes('invalid-proof: this proof does not establish the equality'),
    result.codes,
  )
}

console.log(`\nparadox: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}

