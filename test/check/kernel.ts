// Kernel test: build the Boolean double-negation theorem (the IIT-CoC reference corpus) against the kernel API
// and confirm every definition checks. Also confirm a deliberate type mismatch is caught.
// Also confirm a definition whose check does not end is refused alone, out of its step budget (decision 047).
// Run: npx tsx test/check/kernel.ts
//
// On check/kernel-terms.tree, the port of check/kernel.ts (item term-self-host-001-0090). A binder is a term (spec 4.6):
// `lambda(x => ...)` only names the bound variable while the term is built, and the term holds `bound` indices.

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
  messageOf,
  normalize,
} from '@term/make/code/check/kernel-terms'

// a bound variable being built is a placeholder level no real variable has, turned into its index once its binder
// is known
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

const book: CocEntry[] = [
  // Self : * = lambda F. self s. { s : (F s) }
  makeEntry(
    'Self',
    universe,
    lambda(F => self(s => annotate(s, apply(F, s)))),
  ),
  // Equal : * = lambda a. lambda b. forall (P: forall (x: *) *) forall (x: (P a)) (P b)
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
  // Bool : * = (Self lambda self. forall (P: *) forall (t: forall (e: Equal true self) P) forall (f: forall (e: Equal false self) P) P)
  makeEntry(
    'Bool',
    universe,
    apply(
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
  ),
  // true : Bool = lambda P. lambda t. lambda f. (t (refl *))
  makeEntry(
    'true',
    ref('Bool'),
    lambda(() =>
      lambda(t => lambda(() => apply(t, apply(ref('refl'), universe)))),
    ),
  ),
  // false : Bool = lambda P. lambda t. lambda f. (f (refl *))
  makeEntry(
    'false',
    ref('Bool'),
    lambda(() =>
      lambda(() => lambda(f => apply(f, apply(ref('refl'), universe)))),
    ),
  ),
  // match : forall (b: Bool) forall (P: forall (x: Bool) *) forall (t: P true) forall (f: P false) (P b)
  //       = lambda b. lambda P. lambda t. lambda f. (b (P b) lambda e.(e P t) lambda e.(e P f))
  makeEntry(
    'match',
    pi(ref('Bool'), b =>
      pi(
        pi(ref('Bool'), () => universe),
        P =>
          pi(apply(P, ref('true')), () =>
            pi(apply(P, ref('false')), () => apply(P, b)),
          ),
      ),
    ),
    lambda(b =>
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
  ),
  // not : forall (b: Bool) Bool = lambda b. (match b lambda b.(Bool) false true)
  makeEntry(
    'not',
    pi(ref('Bool'), () => ref('Bool')),
    lambda(b =>
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
  ),
  // theorem : forall (b: Bool) (Equal (not (not b)) b)
  //         = lambda b. (match b lambda b.(Equal (not (not b)) b) (refl *) (refl *))
  makeEntry(
    'theorem',
    pi(ref('Bool'), b =>
      eq(apply(ref('not'), apply(ref('not'), b)), b),
    ),
    lambda(b =>
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

  // a deliberate type mismatch must be caught: a value annotated as `true` re-annotated as `false`. The kernel raises
  // a `failure` whose note carries the kind `kernel-mismatch:` (the original's TypeMismatch)
  let caught = false

  try {
    normalize(
      book,
      annotate(annotate(makeVariable(0), ref('true')), ref('false')),
      0,
    )
  } catch (error) {
    const note = (error as { note?: unknown } | null)?.note
    caught =
      typeof note === 'string' &&
      note.startsWith('kernel-mismatch:') &&
      messageOf(note).startsWith('type mismatch')
  }

  if (caught) {
    pass++
    console.log('ok    rejects a bad annotation')
  } else {
    fail++
    console.log(
      'FAIL  rejects a bad annotation (did not raise a type mismatch)',
    )
  }

  // a definition whose check does not end is refused alone, out of its step budget, and every other definition still
  // checks (decision 047). loop : * = (lambda x. (x x)) (lambda x. (x x)) reduces to itself forever
  const omega = lambda(x => apply(x, x))
  const looping = [
    ...book,
    makeEntry('loop', universe, apply(omega, omega)),
  ]
  const results = checkBook(looping)
  const loop = results.find(result => result.name === 'loop')
  const others = results.filter(result => result.name !== 'loop')

  if (
    loop &&
    !loop.ok &&
    /^the check did not finish within \d+ reduction steps$/.test(
      loop.error,
    ) &&
    others.length === book.length &&
    others.every(result => result.ok)
  ) {
    pass++
    console.log('ok    refuses a check that does not end, alone')
  } else {
    fail++
    console.log(
      `FAIL  refuses a check that does not end, alone: ${JSON.stringify(results)}`,
    )
  }

  console.log(`\nkernel: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }
}

main()
