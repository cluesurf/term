// Kernel test: build the Boolean double-negation theorem (the IIT-CoC reference corpus) against the kernel API
// and confirm every definition checks. Also confirm a deliberate type mismatch is caught.
// Run: npx tsx test/check/kernel.ts

import type { Book, Term } from '@cluesurf/make/code/check/kernel'
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
} from '@cluesurf/make/code/check/kernel'

const ref = reference
const eq = (x: Term, y: Term): Term => apply(apply(ref('Equal'), x), y)

const book: Book = {
  // Self : * = lambda F. self s. { s : (F s) }
  Self: {
    type: universe,
    value: lambda(F => self(s => annotate(s, apply(F, s)))),
  },
  // Equal : * = lambda a. lambda b. forall (P: forall (x: *) *) forall (x: (P a)) (P b)
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
  // Bool : * = (Self lambda self. forall (P: *) forall (t: forall (e: Equal true self) P) forall (f: forall (e: Equal false self) P) P)
  Bool: {
    type: universe,
    value: apply(
      ref('Self'),
      lambda(s =>
        pi(universe, P =>
          pi(
            pi(eq(ref('true'), s), () => P),
            () =>
              pi(
                pi(eq(ref('false'), s), () => P),
                () => P,
              ),
          ),
        ),
      ),
    ),
  },
  // true : Bool = lambda P. lambda t. lambda f. (t (refl *))
  true: {
    type: ref('Bool'),
    value: lambda(() =>
      lambda(t => lambda(() => apply(t, apply(ref('refl'), universe)))),
    ),
  },
  // false : Bool = lambda P. lambda t. lambda f. (f (refl *))
  false: {
    type: ref('Bool'),
    value: lambda(() =>
      lambda(() => lambda(f => apply(f, apply(ref('refl'), universe)))),
    ),
  },
  // match : forall (b: Bool) forall (P: forall (x: Bool) *) forall (t: P true) forall (f: P false) (P b)
  //       = lambda b. lambda P. lambda t. lambda f. (b (P b) lambda e.(e P t) lambda e.(e P f))
  match: {
    type: pi(ref('Bool'), b =>
      pi(
        pi(ref('Bool'), () => universe),
        P =>
          pi(apply(P, ref('true')), () =>
            pi(apply(P, ref('false')), () => apply(P, b)),
          ),
      ),
    ),
    value: lambda(b =>
      lambda(P =>
        lambda(t =>
          lambda(f =>
            apply(
              apply(
                apply(b, apply(P, b)),
                lambda(e => apply(apply(e, P), t)),
              ),
              lambda(e => apply(apply(e, P), f)),
            ),
          ),
        ),
      ),
    ),
  },
  // not : forall (b: Bool) Bool = lambda b. (match b lambda b.(Bool) false true)
  not: {
    type: pi(ref('Bool'), () => ref('Bool')),
    value: lambda(b =>
      apply(
        apply(
          apply(
            apply(ref('match'), b),
            lambda(() => ref('Bool')),
          ),
          ref('false'),
        ),
        ref('true'),
      ),
    ),
  },
  // theorem : forall (b: Bool) (Equal (not (not b)) b)
  //         = lambda b. (match b lambda b.(Equal (not (not b)) b) (refl *) (refl *))
  theorem: {
    type: pi(ref('Bool'), b =>
      eq(apply(ref('not'), apply(ref('not'), b)), b),
    ),
    value: lambda(b =>
      apply(
        apply(
          apply(
            apply(ref('match'), b),
            lambda(b2 =>
              eq(apply(ref('not'), apply(ref('not'), b2)), b2),
            ),
          ),
          apply(ref('refl'), universe),
        ),
        apply(ref('refl'), universe),
      ),
    ),
  },
}

let pass = 0
let fail = 0

function main(): void {
  const results = checkBook(book)
  for (const result of results) {
    if (result.ok) {
      pass++
      console.log(`ok    ${result.name}`)
    } else {
      fail++
      console.log(`FAIL  ${result.name}\n${result.error}`)
    }
  }

  // a deliberate type mismatch must be caught: a value annotated as `true` re-annotated as `false`
  let caught = false
  try {
    normal(
      book,
      annotate(
        annotate(variable(0), reference('true')),
        reference('false'),
      ),
    )
  } catch (error) {
    caught = error instanceof TypeMismatch
  }
  if (caught) {
    pass++
    console.log('ok    rejects a bad annotation')
  } else {
    fail++
    console.log('FAIL  rejects a bad annotation (did not throw)')
  }

  console.log(`\nkernel: ${pass} pass, ${fail} fail`)
}

main()
