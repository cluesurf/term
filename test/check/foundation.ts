// Foundation check: build the bottom of the math genome as kernel terms and confirm every definition checks.
// This is the convergence point made literal. The same self-typed Calculus of Constructions that is Seed's
// type system is the foundation the math library (form.tree) elaborates into. Here the kernel itself checks
// the booleans and the natural numbers, with zero, successor, induction, and addition, all as self types.
// Run: npx tsx test/check/foundation.ts
//
// On check/kernel-terms.tree, the port of check/kernel.ts (item term-self-host-001-0090). A binder is a term (spec
// 4.6), so "one plus one computes to two" compares the two normal forms in full: the original's comparison turned every
// binder into '<fn>' and compared only the outermost shape.

import type {
  CocEntry,
  CocTerm,
} from '@term/make/code/check/kernel-terms'
import {
  checkBook,
  makeAnnotate,
  makeApply,
  makeBound,
  makeEntry,
  makeLambda,
  makePi,
  makeReference,
  makeSelf,
  makeUniverse,
  makeVariable,
  normalize,
  showTerm,
} from '@term/make/code/check/kernel-terms'

let placeholder = -1000

function abstract(
  term: CocTerm,
  level: number,
  depth: number,
): CocTerm {
  switch (term.tag) {
    case 'variable':
      return term.level === level ? makeBound(depth) : term
    case 'pi':
      return makePi(
        abstract(term.input, level, depth),
        abstract(term.body, level, depth + 1),
      )
    case 'lambda':
      return makeLambda(abstract(term.body, level, depth + 1))
    case 'self':
      return makeSelf(abstract(term.body, level, depth + 1))
    case 'apply':
      return makeApply(
        abstract(term.fun, level, depth),
        abstract(term.arg, level, depth),
      )
    case 'annotate':
      return makeAnnotate(
        abstract(term.value, level, depth),
        abstract(term.type, level, depth),
      )
    default:
      return term
  }
}

function binder(f: (x: CocTerm) => CocTerm): CocTerm {
  const level = placeholder--

  return abstract(f(makeVariable(level)), level, 0)
}

const lambda = (f: (x: CocTerm) => CocTerm): CocTerm =>
  makeLambda(binder(f))
const pi = (input: CocTerm, f: (x: CocTerm) => CocTerm): CocTerm =>
  makePi(input, binder(f))
const self = (f: (x: CocTerm) => CocTerm): CocTerm =>
  makeSelf(binder(f))
const apply = makeApply
const annotate = makeAnnotate
const ref = makeReference
const universe = makeUniverse()
const eq = (x: CocTerm, y: CocTerm): CocTerm =>
  apply(apply(ref('Equal'), x), y)
// convenience: apply a function to several arguments in order
const at = (fun: CocTerm, ...args: CocTerm[]): CocTerm =>
  args.reduce((f, a) => apply(f, a), fun)

const book: CocEntry[] = [
  // Self : * = lambda F. self s. { s : (F s) }
  makeEntry(
    'Self',
    universe,
    lambda(F => self(s => annotate(s, apply(F, s)))),
  ),
  // Equal a b : * = forall (P: * -> *). P a -> P b   (Leibniz equality)
  makeEntry(
    'Equal',
    universe,
    lambda(a =>
      lambda(b =>
        pi(
          pi(universe, () => universe),
          P => pi(apply(P, a), () => apply(P, b)),
        ),
      ),
    ),
  ),
  // refl : forall (a: *) (Equal a a) = lambda a. lambda P. lambda x. x
  makeEntry(
    'refl',
    pi(universe, a => eq(a, a)),
    lambda(() => lambda(() => lambda(x => x))),
  ),
  // Natural : * = Self (lambda s. forall (P: Natural -> *).
  //                       P zero -> (forall (n: Natural). P n -> P (succ n)) -> P s)
  makeEntry(
    'Natural',
    universe,
    apply(
      ref('Self'),
      lambda(s =>
        pi(
          pi(ref('Natural'), () => universe),
          P =>
            pi(apply(P, ref('zero')), () =>
              pi(
                pi(ref('Natural'), n =>
                  pi(apply(P, n), () =>
                    apply(P, apply(ref('succ'), n)),
                  ),
                ),
                () => apply(P, s),
              ),
            ),
        ),
      ),
    ),
  ),
  // zero : Natural = lambda P. lambda z. lambda s. z
  makeEntry(
    'zero',
    ref('Natural'),
    lambda(() => lambda(z => lambda(() => z))),
  ),
  // succ : Natural -> Natural = lambda n. lambda P. lambda z. lambda s. (s n (n P z s))
  makeEntry(
    'succ',
    pi(ref('Natural'), () => ref('Natural')),
    lambda(n =>
      lambda(P => lambda(z => lambda(s => at(s, n, at(n, P, z, s))))),
    ),
  ),
  // induct : the induction principle, the eliminator carried by the self type
  //        = lambda P. lambda z. lambda s. lambda m. (m P z s)
  makeEntry(
    'induct',
    pi(
      pi(ref('Natural'), () => universe),
      P =>
        pi(apply(P, ref('zero')), () =>
          pi(
            pi(ref('Natural'), n =>
              pi(apply(P, n), () => apply(P, apply(ref('succ'), n))),
            ),
            () => pi(ref('Natural'), m => apply(P, m)),
          ),
        ),
    ),
    lambda(P => lambda(z => lambda(s => lambda(m => at(m, P, z, s))))),
  ),
  // plus : Natural -> Natural -> Natural = lambda a. lambda b. (a (lambda _. Natural) b (lambda _. lambda r. succ r))
  makeEntry(
    'plus',
    pi(ref('Natural'), () => pi(ref('Natural'), () => ref('Natural'))),
    lambda(a =>
      lambda(b =>
        at(
          a,
          lambda(() => ref('Natural')),
          b,
          lambda(() => lambda(r => apply(ref('succ'), r))),
        ),
      ),
    ),
  ),
  // one : Natural = succ zero
  makeEntry('one', ref('Natural'), apply(ref('succ'), ref('zero'))),
  // two : Natural = succ one
  makeEntry('two', ref('Natural'), apply(ref('succ'), ref('one'))),

  // ----- proven theorems, discharged as proof terms, not asserted axioms -----

  // addZeroLeft : forall (n: Natural). Equal (plus zero n) n
  makeEntry(
    'addZeroLeft',
    pi(ref('Natural'), n => eq(at(ref('plus'), ref('zero'), n), n)),
    lambda(() => apply(ref('refl'), universe)),
  ),
  // addSuccLeft : forall (m n: Natural). Equal (plus (succ m) n) (succ (plus m n))
  makeEntry(
    'addSuccLeft',
    pi(ref('Natural'), m =>
      pi(ref('Natural'), n =>
        eq(
          at(ref('plus'), apply(ref('succ'), m), n),
          apply(ref('succ'), at(ref('plus'), m, n)),
        ),
      ),
    ),
    lambda(() => lambda(() => apply(ref('refl'), universe))),
  ),
  // double : Natural -> Natural = lambda n. plus n n
  makeEntry(
    'double',
    pi(ref('Natural'), () => ref('Natural')),
    lambda(n => at(ref('plus'), n, n)),
  ),
  // doubleOne : Equal (double one) two
  makeEntry(
    'doubleOne',
    eq(apply(ref('double'), ref('one')), ref('two')),
    apply(ref('refl'), universe),
  ),
]

let pass = 0
let fail = 0

function main(): void {
  for (const result of checkBook(book)) {
    if (result.ok) {
      pass++
      console.log(`ok    ${result.name}`)
    } else {
      fail++
      console.log(`FAIL  ${result.name}\n${result.error}`)
    }
  }

  // one plus one normalizes to the same normal form as two: the computation rules fire. Shown in full, every waiting
  // body run
  const normalizedSum = normalize(
    book,
    annotate(
      apply(apply(ref('plus'), ref('one')), ref('one')),
      ref('Natural'),
    ),
    0,
  )
  const normalizedTwo = normalize(
    book,
    annotate(ref('two'), ref('Natural')),
    0,
  )

  if (
    showTerm(book, normalizedSum, 0) ===
    showTerm(book, normalizedTwo, 0)
  ) {
    pass++
    console.log('ok    one plus one computes to two')
  } else {
    fail++
    console.log('FAIL  one plus one did not compute to two')
  }

  // a deliberate type mismatch must be caught.
  let caught = false

  try {
    normalize(
      book,
      annotate(annotate(makeVariable(0), ref('zero')), ref('Equal')),
      0,
    )
  } catch (error) {
    const note = (error as { note?: unknown } | null)?.note
    caught =
      typeof note === 'string' &&
      (note.startsWith('kernel-mismatch:') ||
        note.startsWith('kernel-fault:'))
  }

  if (caught) {
    pass++
    console.log('ok    rejects a bad annotation')
  } else {
    fail++
    console.log('FAIL  rejects a bad annotation (did not raise)')
  }

  console.log(`\nfoundation: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }
}

main()
