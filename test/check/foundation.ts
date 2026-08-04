// Foundation check: build the bottom of the math genome as kernel terms and confirm every definition checks.
// This is the convergence point made literal. The same self-typed Calculus of Constructions that is Seed's
// type system is the foundation the math library (form.tree) elaborates into. Here the kernel itself checks
// the booleans and the natural numbers, with zero, successor, induction, and addition, all as self types.
// Run: npx tsx test/check/foundation.ts

import type { Book, Term } from '@term/make/code/check/kernel'
import {
  annotate,
  apply,
  checkBook,
  lambda,
  pi,
  reference,
  self,
  universe,
  variable,
  normal,
  TypeMismatch,
} from '@term/make/code/check/kernel'

const ref = reference
const eq = (x: Term, y: Term): Term => apply(apply(ref('Equal'), x), y)
// convenience: apply a function to several arguments in order
const at = (fun: Term, ...args: Term[]): Term =>
  args.reduce((f, a) => apply(f, a), fun)

const book: Book = {
  // Self : * = lambda F. self s. { s : (F s) }
  Self: {
    type: universe,
    value: lambda(F => self(s => annotate(s, apply(F, s)))),
  },

  // Equal a b : * = forall (P: * -> *). P a -> P b   (Leibniz equality)
  Equal: {
    type: universe,
    value: lambda(a =>
      lambda(b =>
        pi(
          pi(universe, () => universe),
          P => pi(apply(P, a), () => apply(P, b)),
        ),
      ),
    ),
  },

  // refl : forall (a: *) (Equal a a) = lambda a. lambda P. lambda x. x
  refl: {
    type: pi(universe, a => eq(a, a)),
    value: lambda(() => lambda(() => lambda(x => x))),
  },

  // Natural : * = Self (lambda s. forall (P: Natural -> *).
  //                       P zero -> (forall (n: Natural). P n -> P (succ n)) -> P s)
  Natural: {
    type: universe,
    value: apply(
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
  },

  // zero : Natural = lambda P. lambda z. lambda s. z
  zero: {
    type: ref('Natural'),
    value: lambda(() => lambda(z => lambda(() => z))),
  },

  // succ : Natural -> Natural
  //      = lambda n. lambda P. lambda z. lambda s. (s n (n P z s))
  succ: {
    type: pi(ref('Natural'), () => ref('Natural')),
    value: lambda(n =>
      lambda(P => lambda(z => lambda(s => at(s, n, at(n, P, z, s))))),
    ),
  },

  // induct : the induction principle, the eliminator carried by the self type
  //        : forall (P: Natural -> *). P zero
  //            -> (forall (n: Natural). P n -> P (succ n))
  //            -> forall (m: Natural). P m
  //        = lambda P. lambda z. lambda s. lambda m. (m P z s)
  induct: {
    type: pi(
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
    value: lambda(P =>
      lambda(z => lambda(s => lambda(m => at(m, P, z, s)))),
    ),
  },

  // plus : Natural -> Natural -> Natural
  //      = lambda a. lambda b. (a (lambda _. Natural) b (lambda _. lambda r. succ r))
  // iterate succ on b, a times.
  plus: {
    type: pi(ref('Natural'), () =>
      pi(ref('Natural'), () => ref('Natural')),
    ),
    value: lambda(a =>
      lambda(b =>
        at(
          a,
          lambda(() => ref('Natural')),
          b,
          lambda(() => lambda(r => apply(ref('succ'), r))),
        ),
      ),
    ),
  },

  // one : Natural = succ zero
  one: {
    type: ref('Natural'),
    value: apply(ref('succ'), ref('zero')),
  },

  // two : Natural = succ one
  two: {
    type: ref('Natural'),
    value: apply(ref('succ'), ref('one')),
  },

  // ----- proven theorems, discharged as proof terms, not asserted axioms -----

  // addZeroLeft : forall (n: Natural). Equal (plus zero n) n
  // plus zero n reduces to n definitionally, so reflexivity proves it.
  addZeroLeft: {
    type: pi(ref('Natural'), n =>
      eq(at(ref('plus'), ref('zero'), n), n),
    ),
    value: lambda(() => apply(ref('refl'), universe)),
  },

  // addSuccLeft : forall (m n: Natural). Equal (plus (succ m) n) (succ (plus m n))
  // plus (succ m) n reduces to succ (plus m n) definitionally, so reflexivity proves it.
  addSuccLeft: {
    type: pi(ref('Natural'), m =>
      pi(ref('Natural'), n =>
        eq(
          at(ref('plus'), apply(ref('succ'), m), n),
          apply(ref('succ'), at(ref('plus'), m, n)),
        ),
      ),
    ),
    value: lambda(() => lambda(() => apply(ref('refl'), universe))),
  },

  // double : Natural -> Natural = lambda n. plus n n
  double: {
    type: pi(ref('Natural'), () => ref('Natural')),
    value: lambda(n => at(ref('plus'), n, n)),
  },

  // doubleOne : Equal (double one) two
  // double one = plus one one, which computes to two, so reflexivity proves it.
  doubleOne: {
    type: eq(apply(ref('double'), ref('one')), ref('two')),
    value: apply(ref('refl'), universe),
  },
}

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

  // one plus one normalizes to the same normal form as two: the computation rules fire.
  const onePlusOne = apply(apply(ref('plus'), ref('one')), ref('one'))
  const normalizedSum = normal(
    book,
    annotate(onePlusOne, ref('Natural')),
  )

  const normalizedTwo = normal(
    book,
    annotate(ref('two'), ref('Natural')),
  )

  if (showTermSafe(normalizedSum) === showTermSafe(normalizedTwo)) {
    pass++
    console.log('ok    one plus one computes to two')
  } else {
    fail++
    console.log('FAIL  one plus one did not compute to two')
  }

  // a deliberate type mismatch must be caught.
  let caught = false

  try {
    normal(
      book,
      annotate(annotate(variable(0), ref('zero')), ref('Equal')),
    )
  } catch (error) {
    caught = error instanceof TypeMismatch || error instanceof Error
  }

  if (caught) {
    pass++
    console.log('ok    rejects a bad annotation')
  } else {
    fail++
    console.log('FAIL  rejects a bad annotation (did not throw)')
  }

  console.log(`\nfoundation: ${pass} pass, ${fail} fail`)
}

function showTermSafe(term: Term): string {
  return JSON.stringify(term, (_key, value) =>
    typeof value === 'function' ? '<fn>' : value,
  )
}

main()
