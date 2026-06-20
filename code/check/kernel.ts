// The dependent type kernel: a Calculus of Constructions with self-types, the proof island of the type system.
// Validity is decided by normalization plus definitional equality. The computation rules are justified by
// interaction-combinator semantics, which is what ties the kernel to the vibe substrate's pure plane. Ported from
// the IIT-CoC reference (land/code/HigherOrderCO/gist/iit-coc.ts). Standard type-theory terms, browser-safe.
//
// This is layer 3 of the type system (see note/research/vibe/computation/plans/04-typecheck.md). Pure, total, and
// erased: it states and checks theorems, it is not the imperative surface. The surface checker is infer.ts.

// Terms use higher-order abstract syntax: a binder is a real function, so substitution is application. Variables
// carry a de Bruijn level for equality.
export type Term =
  | { tag: 'variable'; level: number }
  | { tag: 'pi'; input: Term; body: (x: Term) => Term } // dependent function type: for all (x: input) body
  | { tag: 'lambda'; body: (x: Term) => Term } // function
  | { tag: 'apply'; fun: Term; arg: Term }
  | { tag: 'self'; body: (x: Term) => Term } // self type, the foundation under inductive types
  | { tag: 'annotate'; value: Term; type: Term }
  | { tag: 'reference'; name: string }

export const variable = (level: number): Term => ({
  tag: 'variable',
  level,
})
export const lambda = (body: (x: Term) => Term): Term => ({
  tag: 'lambda',
  body,
})
export const pi = (input: Term, body: (x: Term) => Term): Term => ({
  tag: 'pi',
  input,
  body,
})
export const apply = (fun: Term, arg: Term): Term => ({
  tag: 'apply',
  fun,
  arg,
})
export const self = (body: (x: Term) => Term): Term => ({
  tag: 'self',
  body,
})
export const annotate = (value: Term, type: Term): Term => ({
  tag: 'annotate',
  value,
  type,
})
export const reference = (name: string): Term => ({
  tag: 'reference',
  name,
})

// the universe (the type of types): the self-type identity
export const universe: Term = self(x => x)

// a book of named definitions, each with a declared type and a value
export type Book = Record<string, { type: Term; value: Term }>

export class TypeMismatch extends Error {
  constructor(public expected: string, public detected: string) {
    super(
      `type mismatch\n- expected: ${expected}\n- detected: ${detected}`,
    )
  }
}

// expand a reference to its value
function deref(book: Book, term: Term): Term {
  if (term.tag === 'reference' && book[term.name]) {
    return reduce(book, book[term.name]!.value)
  }
  return term
}

// reduce to weak head normal form
export function reduce(book: Book, term: Term): Term {
  switch (term.tag) {
    case 'variable':
      return term
    case 'lambda':
      return term
    case 'pi':
      return term
    case 'apply':
      return reduceApply(book, reduce(book, term.fun), term.arg)
    case 'self':
      return term
    case 'annotate':
      return reduceAnnotate(book, term.value, reduce(book, term.type))
    case 'reference':
      return term
  }
}

// reduce an annotation: push the type through a function or a self type
function reduceAnnotate(book: Book, value: Term, type: Term): Term {
  const head = deref(book, type)
  // { t : for all (x: A) B }  reduces to  lambda x. { (t {x:A}) : B }
  if (head.tag === 'pi') {
    return lambda(x =>
      annotate(apply(value, annotate(x, head.input)), head.body(x)),
    )
  }
  // { t : self x. T }  reduces to  T[x <- t]
  if (head.tag === 'self') {
    return reduce(book, head.body(value))
  }
  return annotate(value, type)
}

// reduce an application
function reduceApply(book: Book, fun: Term, arg: Term): Term {
  const head = deref(book, fun)
  if (head.tag === 'lambda') {
    return reduce(book, head.body(arg))
  }
  if (head.tag === 'annotate') {
    throw new Error('applying a non-function (annotated value)')
  }
  return apply(head, arg)
}

// evaluate a term to full normal form, checking annotations as it goes
export function normal(book: Book, term: Term, depth = 0): Term {
  const head = reduce(book, term)
  switch (head.tag) {
    case 'variable':
      return head
    case 'lambda':
      return lambda(x => normal(book, head.body(x), depth + 1))
    case 'pi':
      return pi(normal(book, head.input, depth), x =>
        normal(book, head.body(annotate(x, head.input)), depth + 1),
      )
    case 'apply':
      return apply(
        normal(book, head.fun, depth),
        normal(book, head.arg, depth),
      )
    case 'self':
      return self(x => normal(book, head.body(x), depth + 1))
    case 'annotate':
      return normalAnnotate(
        book,
        normal(book, head.value, depth),
        normal(book, head.type, depth),
        depth,
      )
    case 'reference':
      return book[head.name]
        ? normal(book, book[head.name]!.value, depth)
        : head
  }
}

// the annotation check: where type mismatches are caught
function normalAnnotate(
  book: Book,
  value: Term,
  type: Term,
  depth: number,
): Term {
  switch (value.tag) {
    case 'annotate': {
      if (!equal(book, value.type, type, depth)) {
        throw new TypeMismatch(
          showTerm(type, depth),
          showTerm(value.type, depth),
        )
      }
      return annotate(value.value, value.type)
    }
    case 'lambda':
      throw new Error('a bare function cannot be annotated here')
    default:
      return annotate(value, type)
  }
}

// definitional equality, by structure under normalization
export function equal(
  book: Book,
  a: Term,
  b: Term,
  depth: number,
): boolean {
  if (a.tag === 'variable' && b.tag === 'variable')
    return a.level === b.level
  if (a.tag === 'lambda' && b.tag === 'lambda')
    return equal(
      book,
      a.body(variable(depth)),
      b.body(variable(depth)),
      depth + 1,
    )
  if (a.tag === 'apply' && b.tag === 'apply')
    return (
      equal(book, a.fun, b.fun, depth) &&
      equal(book, a.arg, b.arg, depth)
    )
  if (a.tag === 'pi' && b.tag === 'pi') {
    return (
      equal(book, a.input, b.input, depth) &&
      equal(
        book,
        a.body(variable(depth)),
        b.body(variable(depth)),
        depth + 1,
      )
    )
  }
  if (a.tag === 'self' && b.tag === 'self')
    return equal(
      book,
      a.body(variable(depth)),
      b.body(variable(depth)),
      depth + 1,
    )
  if (a.tag === 'reference' && book[a.name])
    return equal(
      book,
      normal(book, book[a.name]!.value, depth),
      b,
      depth,
    )
  if (b.tag === 'reference' && book[b.name])
    return equal(
      book,
      a,
      normal(book, book[b.name]!.value, depth),
      depth,
    )
  if (a.tag === 'annotate') return equal(book, a.value, b, depth)
  if (b.tag === 'annotate') return equal(book, a, b.value, depth)
  if (a.tag === 'lambda')
    return equal(
      book,
      a,
      lambda(x => apply(b, x)),
      depth,
    )
  if (b.tag === 'lambda')
    return equal(
      book,
      lambda(x => apply(a, x)),
      b,
      depth,
    )
  return false
}

export type CheckResult = { name: string; ok: boolean; error?: string }

// check every definition in a book: normalize each value against its declared type
export function checkBook(book: Book): Array<CheckResult> {
  const results: Array<CheckResult> = []
  for (const name in book) {
    try {
      normal(book, annotate(book[name]!.value, book[name]!.type))
      results.push({ name, ok: true })
    } catch (error) {
      results.push({
        name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return results
}

export function showTerm(term: Term, depth = 0): string {
  switch (term.tag) {
    case 'variable':
      return numberToName(term.level)
    case 'lambda':
      return `lambda ${numberToName(depth)} ${showTerm(
        term.body(variable(depth)),
        depth + 1,
      )}`
    case 'pi':
      return `forall (${numberToName(depth)}: ${showTerm(
        term.input,
        depth,
      )}) ${showTerm(term.body(variable(depth)), depth + 1)}`
    case 'apply':
      return `(${showTerm(term.fun, depth)} ${showTerm(
        term.arg,
        depth,
      )})`
    case 'self':
      return `self ${numberToName(depth)} ${showTerm(
        term.body(variable(depth)),
        depth + 1,
      )}`
    case 'annotate':
      return `{${showTerm(term.value, depth)}: ${showTerm(
        term.type,
        depth,
      )}}`
    case 'reference':
      return `@${term.name}`
  }
}

function numberToName(value: number): string {
  let text = ''
  let n = value + 1
  while (n > 0) {
    text += String.fromCharCode(((n - 1) % 26) + 'a'.charCodeAt(0))
    n = Math.floor((n - 1) / 26)
  }
  return text.split('').reverse().join('')
}
