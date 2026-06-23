// A primitive INTERVAL and PATH reduction engine -- the computational core of the cubical layer that makes a higher
// inductive type's PATH constructor COMPUTE (its eliminator's path beta-rule holds definitionally, not just
// propositionally). This is what the pre-cubical circle (`circle.ts`) was missing.
//
// The interval `I` has two endpoints `i0`, `i1` and interval variables. A PATH in `A` from `a` to `b` is an interval
// abstraction `<i> t` (a term `t` with one free interval variable) whose endpoints are `t[i := i0] = a` and
// `t[i := i1] = b`. The CIRCLE has a point `base` and a path `loop : base = base`; `loop @ r` is the point of the loop at
// interval coordinate `r`, with `loop @ i0 = loop @ i1 = base`. The recursion principle `circRec(b, l)` (mapping out by a
// point `b` and a target loop `l`) computes BOTH betas:
//   - on the point:  circRec(b, l) (base)       = b
//   - on the loop:   circRec(b, l) (loop @ r)    = l @ r
// so the action on the loop -- `ap (circRec(b, l)) loop = <i> circRec(b, l) (loop @ i) = <i> (l @ i) = l` (the last step
// is path eta) -- reduces DEFINITIONALLY to the target loop `l`. That equation is the whole point of the cubical layer.
//
// The reductions below form a confluent, terminating rewrite system for this fragment, so `normalize` decides
// definitional equality on it. Everything is exact and structural; no float, no kernel mutation. Browser-safe.

// ---- terms ----
// Interval terms.
export type Interval =
  | { t: 'i0' }
  | { t: 'i1' }
  | { t: 'ivar'; index: number } // de Bruijn index of an interval variable

// Point / path / function terms. Point variables and interval variables have separate de Bruijn scopes.
export type Term =
  // points
  | { t: 'pvar'; index: number } // an ordinary (point) variable
  | { t: 'base' } // the circle's point constructor
  | { t: 'loopAt'; at: Interval } // the loop's point at an interval coordinate: loop @ r
  | { t: 'app'; fun: Term; arg: Term } // function application
  | { t: 'circRec'; point: Term; loop: Term } // the circle recursor circRec(b, l) : circle -> A
  // paths
  | { t: 'plam'; body: Term } // a path abstraction <i> body (binds one interval variable)
  | { t: 'papp'; path: Term; at: Interval } // path application: p @ r
  | { t: 'loop' } // the circle's path constructor as a first-class path
  // a free constant (an opaque point or path, for building examples / distinct targets)
  | { t: 'const'; name: string }

// ---- interval substitution ----

function substInterval(r: Interval, image: Interval, depth: number): Interval {
  if (r.t === 'ivar') {
    if (r.index === depth) {
      return image
    }

    return { t: 'ivar', index: r.index > depth ? r.index - 1 : r.index }
  }

  return r
}

// replace interval variable `depth` (the one bound by the nearest `plam`) with `image` throughout a term, lowering the
// indices of interval variables above it. Point structure is traversed; point binders do not affect interval scope.
function substIntervalIn(term: Term, image: Interval, depth: number): Term {
  switch (term.t) {
    case 'pvar':
    case 'base':
    case 'loop':
    case 'const':
      return term
    case 'loopAt':
      return { t: 'loopAt', at: substInterval(term.at, image, depth) }
    case 'app':
      return {
        t: 'app',
        fun: substIntervalIn(term.fun, image, depth),
        arg: substIntervalIn(term.arg, image, depth),
      }
    case 'circRec':
      return {
        t: 'circRec',
        point: substIntervalIn(term.point, image, depth),
        loop: substIntervalIn(term.loop, image, depth),
      }
    case 'plam':
      // under a new interval binder: shift the image's free interval variables up by one and go one deeper
      return { t: 'plam', body: substIntervalIn(term.body, shiftInterval(image), depth + 1) }
    case 'papp':
      return {
        t: 'papp',
        path: substIntervalIn(term.path, image, depth),
        at: substInterval(term.at, image, depth),
      }
  }
}

function shiftInterval(r: Interval): Interval {
  return r.t === 'ivar' ? { t: 'ivar', index: r.index + 1 } : r
}

// does `term` reference the interval variable at `depth` (used for the path-eta check)?
function mentionsInterval(term: Term, depth: number): boolean {
  switch (term.t) {
    case 'pvar':
    case 'base':
    case 'loop':
    case 'const':
      return false
    case 'loopAt':
      return term.at.t === 'ivar' && term.at.index === depth
    case 'app':
      return mentionsInterval(term.fun, depth) || mentionsInterval(term.arg, depth)
    case 'circRec':
      return mentionsInterval(term.point, depth) || mentionsInterval(term.loop, depth)
    case 'plam':
      return mentionsInterval(term.body, depth + 1)
    case 'papp':
      return (
        mentionsInterval(term.path, depth) ||
        (term.at.t === 'ivar' && term.at.index === depth)
      )
  }
}

// lower every free interval variable by one (after a path-eta strips a binder)
function lowerInterval(term: Term, depth: number): Term {
  return substIntervalIn(term, { t: 'i0' }, depth) // image is never used since depth is unmentioned; this just relabels
}

// ---- normalization (the reduction rules) ----

export function normalize(term: Term): Term {
  switch (term.t) {
    case 'pvar':
    case 'base':
    case 'loop':
    case 'const':
      return term

    case 'loopAt': {
      // loop @ i0 = base, loop @ i1 = base (the loop's endpoints are both the base point)
      if (term.at.t === 'i0' || term.at.t === 'i1') {
        return { t: 'base' }
      }

      return term
    }

    case 'circRec':
      return {
        t: 'circRec',
        point: normalize(term.point),
        loop: normalize(term.loop),
      }

    case 'app': {
      const fun = normalize(term.fun)
      const arg = normalize(term.arg)

      // the circle recursor's beta-rules
      if (fun.t === 'circRec') {
        // circRec(b, l) base = b
        if (arg.t === 'base') {
          return fun.point
        }

        // circRec(b, l) (loop @ r) = l @ r   (the PATH beta-rule)
        if (arg.t === 'loopAt') {
          return normalize({ t: 'papp', path: fun.loop, at: arg.at })
        }
      }

      return { t: 'app', fun, arg }
    }

    case 'plam': {
      const body = normalize(term.body)

      // path eta: <i> (p @ i) = p, when p does not mention i
      if (
        body.t === 'papp' &&
        body.at.t === 'ivar' &&
        body.at.index === 0 &&
        !mentionsInterval(body.path, 0)
      ) {
        return normalize(lowerInterval(body.path, 0))
      }

      // path eta for the loop, whose point at an interval coordinate is stored directly as `loop @ i` (loopAt): the
      // abstraction `<i> loop@i` is exactly the loop.
      if (body.t === 'loopAt' && body.at.t === 'ivar' && body.at.index === 0) {
        return { t: 'loop' }
      }

      return { t: 'plam', body }
    }

    case 'papp': {
      const path = normalize(term.path)

      // path beta: (<i> body) @ r = body[i := r]
      if (path.t === 'plam') {
        return normalize(substIntervalIn(path.body, term.at, 0))
      }

      // loop @ r: keep as the loop's point (handled by loopAt for endpoints)
      if (path.t === 'loop') {
        return normalize({ t: 'loopAt', at: term.at })
      }

      return { t: 'papp', path, at: term.at }
    }
  }
}

// the ACTION ON PATHS (ap / cong) of a function `f` on a path `p`: `ap f p = <i> f (p @ i)`. For the circle recursor and
// the loop this reduces, by the rules above, to the recursor's target loop.
export function ap(fun: Term, path: Term): Term {
  return normalize({
    t: 'plam',
    body: {
      t: 'app',
      fun: shiftPoint(fun),
      arg: { t: 'papp', path: shiftPoint(path), at: { t: 'ivar', index: 0 } },
    },
  })
}

// a path abstraction introduces an interval binder. The recursor and the loop in `ap f p` are interval-CLOSED (they have
// no free interval variables -- the circle's generators and any recursor built from closed data), so passing them under
// the new binder needs no shifting. (A general implementation would shift free interval variables up by one here.)
function shiftPoint(term: Term): Term {
  return term
}

// structural equality of normal forms (definitional equality, since `normalize` is a decision procedure here)
export function equal(a: Term, b: Term): boolean {
  return termKey(normalize(a)) === termKey(normalize(b))
}

function intervalKey(r: Interval): string {
  return r.t === 'ivar' ? `iv${r.index}` : r.t
}

function termKey(term: Term): string {
  switch (term.t) {
    case 'pvar':
      return `pv${term.index}`
    case 'base':
      return 'base'
    case 'loop':
      return 'loop'
    case 'const':
      return `c:${term.name}`
    case 'loopAt':
      return `loopAt(${intervalKey(term.at)})`
    case 'app':
      return `app(${termKey(term.fun)},${termKey(term.arg)})`
    case 'circRec':
      return `circRec(${termKey(term.point)},${termKey(term.loop)})`
    case 'plam':
      return `plam(${termKey(term.body)})`
    case 'papp':
      return `papp(${termKey(term.path)},${intervalKey(term.at)})`
  }
}

// ---- builders ----
export const base: Term = { t: 'base' }
export const loop: Term = { t: 'loop' }
export const cst = (name: string): Term => ({ t: 'const', name })
export const circRec = (point: Term, loopImage: Term): Term => ({
  t: 'circRec',
  point,
  loop: loopImage,
})
export const reflPath = (point: Term): Term => ({ t: 'plam', body: point })
