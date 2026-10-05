function __termInt(x: number): number {
  if (!(x <= 9007199254740991 && x >= -9007199254740991)) __termIntStop(x)
  return x
}
function __termIntStop(x: number): never {
  const base = !Number.isFinite(x)
    ? { host: "@term/base", form: "defect", note: "Invalid", code: "", time: Date.now(), link: { thing: "a division or remainder by zero" } }
    : { host: "@term/base", form: x > 0 ? "excess" : "shortage", note: x > 0 ? "Too large" : "Too small", code: "", time: Date.now(), link: { thing: "number", limit: x > 0 ? 9007199254740991 : -9007199254740991, actual: x } }
  throw Object.assign(new Error(base.note), base, { name: "TermException" })
}

const __termVariantI0 = Object.freeze({ t: "i0" as const })

const __termVariantBase = Object.freeze({ t: "base" as const })

const __termVariantLoop = Object.freeze({ t: "loop" as const })

export type Interval =
  | { t: "i0" }
  | { t: "i1" }
  | { t: "ivar"; index: number }

export type CubicalTerm =
  | { t: "pvar"; index: number }
  | { t: "base" }
  | { t: "loop-at"; at: Interval }
  | { t: "app"; fun: CubicalTerm; arg: CubicalTerm }
  | { t: "circ-rec"; point: CubicalTerm; loop: CubicalTerm }
  | { t: "plam"; body: CubicalTerm }
  | { t: "papp"; path: CubicalTerm; at: Interval }
  | { t: "loop" }
  | { t: "const"; name: string }

export function makeIvar(index: number): Interval {
  return { t: "ivar", index: index }
}

export function substInterval(r: Interval, image: Interval, depth: number): Interval {
  if (r.t === "i0") {
    return r
  } else if (r.t === "i1") {
    return r
  } else {
    const index = r.index
    if (index === depth) {
      return image
    }
    if (index > depth) {
      return { t: "ivar", index: __termInt(index - 1) }
    }
    return { t: "ivar", index: index }
  }
}

export function shiftInterval(r: Interval): Interval {
  if (r.t === "i0") {
    return r
  } else if (r.t === "i1") {
    return r
  } else {
    const index = r.index
    return { t: "ivar", index: __termInt(index + 1) }
  }
}

export function substIntervalIn(term: CubicalTerm, image: Interval, depth: number): CubicalTerm {
  if (term.t === "pvar") {
    return term
  } else if (term.t === "base") {
    return term
  } else if (term.t === "loop") {
    return term
  } else if (term.t === "const") {
    return term
  } else if (term.t === "loop-at") {
    const at = term.at
    return { t: "loop-at", at: substInterval(at, image, depth) }
  } else if (term.t === "app") {
    const fun = term.fun
    const arg = term.arg
    return { t: "app", fun: substIntervalIn(fun, image, depth), arg: substIntervalIn(arg, image, depth) }
  } else if (term.t === "circ-rec") {
    const point = term.point
    const loop = term.loop
    return { t: "circ-rec", point: substIntervalIn(point, image, depth), loop: substIntervalIn(loop, image, depth) }
  } else if (term.t === "plam") {
    const body = term.body
    return { t: "plam", body: substIntervalIn(body, shiftInterval(image), __termInt(depth + 1)) }
  } else {
    const path = term.path
    const at = term.at
    return { t: "papp", path: substIntervalIn(path, image, depth), at: substInterval(at, image, depth) }
  }
}

export function isIvarAt(r: Interval, depth: number): boolean {
  if (r.t === "i0") {
    return false
  } else if (r.t === "i1") {
    return false
  } else {
    const index = r.index
    return index === depth
  }
}

export function isEndpoint(r: Interval): boolean {
  if (r.t === "i0") {
    return true
  } else if (r.t === "i1") {
    return true
  } else {
    return false
  }
}

export function mentionsInterval(term: CubicalTerm, depth: number): boolean {
  if (term.t === "pvar") {
    return false
  } else if (term.t === "base") {
    return false
  } else if (term.t === "loop") {
    return false
  } else if (term.t === "const") {
    return false
  } else if (term.t === "loop-at") {
    const at = term.at
    return isIvarAt(at, depth)
  } else if (term.t === "app") {
    const fun = term.fun
    const arg = term.arg
    return mentionsInterval(fun, depth) || mentionsInterval(arg, depth)
  } else if (term.t === "circ-rec") {
    const point = term.point
    const loop = term.loop
    return mentionsInterval(point, depth) || mentionsInterval(loop, depth)
  } else if (term.t === "plam") {
    const body = term.body
    return mentionsInterval(body, __termInt(depth + 1))
  } else {
    const path = term.path
    const at = term.at
    return mentionsInterval(path, depth) || isIvarAt(at, depth)
  }
}

export function lowerInterval(term: CubicalTerm, depth: number): CubicalTerm {
  const endpoint: Interval = __termVariantI0
  return substIntervalIn(term, endpoint, depth)
}

export function normalize(term: CubicalTerm): CubicalTerm {
  if (term.t === "pvar") {
    return term
  } else if (term.t === "base") {
    return term
  } else if (term.t === "loop") {
    return term
  } else if (term.t === "const") {
    return term
  } else if (term.t === "loop-at") {
    const at = term.at
    if (isEndpoint(at)) {
      return __termVariantBase
    }
    return term
  } else if (term.t === "circ-rec") {
    const point = term.point
    const loop = term.loop
    return { t: "circ-rec", point: normalize(point), loop: normalize(loop) }
  } else if (term.t === "app") {
    const fun = term.fun
    const arg = term.arg
    const f: CubicalTerm = normalize(fun)
    const a: CubicalTerm = normalize(arg)
    return reduceApp(f, a)
  } else if (term.t === "plam") {
    const body = term.body
    const inside: CubicalTerm = normalize(body)
    return reducePlam(inside)
  } else {
    const path = term.path
    const at = term.at
    const p: CubicalTerm = normalize(path)
    return reducePapp(p, at)
  }
}

export function reduceApp(f: CubicalTerm, a: CubicalTerm): CubicalTerm {
  const kept: CubicalTerm = { t: "app", fun: f, arg: a }
  if (f.t === "circ-rec") {
    const point = f.point
    const loop = f.loop
    if (a.t === "base") {
      return point
    } else if (a.t === "loop-at") {
      const at = a.at
      return normalize({ t: "papp", path: loop, at: at })
    } else if (a.t === "pvar") {
      return kept
    } else if (a.t === "app") {
      return kept
    } else if (a.t === "circ-rec") {
      return kept
    } else if (a.t === "plam") {
      return kept
    } else if (a.t === "papp") {
      return kept
    } else if (a.t === "loop") {
      return kept
    } else {
      return kept
    }
  } else if (f.t === "pvar") {
    return kept
  } else if (f.t === "base") {
    return kept
  } else if (f.t === "loop-at") {
    return kept
  } else if (f.t === "app") {
    return kept
  } else if (f.t === "plam") {
    return kept
  } else if (f.t === "papp") {
    return kept
  } else if (f.t === "loop") {
    return kept
  } else {
    return kept
  }
}

export function reducePlam(inside: CubicalTerm): CubicalTerm {
  const kept: CubicalTerm = { t: "plam", body: inside }
  if (inside.t === "papp") {
    const path = inside.path
    const at = inside.at
    if (isIvarAt(at, 0) && !mentionsInterval(path, 0)) {
      return normalize(lowerInterval(path, 0))
    }
    return kept
  } else if (inside.t === "loop-at") {
    const at = inside.at
    if (isIvarAt(at, 0)) {
      return __termVariantLoop
    }
    return kept
  } else if (inside.t === "pvar") {
    return kept
  } else if (inside.t === "base") {
    return kept
  } else if (inside.t === "app") {
    return kept
  } else if (inside.t === "circ-rec") {
    return kept
  } else if (inside.t === "plam") {
    return kept
  } else if (inside.t === "loop") {
    return kept
  } else {
    return kept
  }
}

export function reducePapp(p: CubicalTerm, r: Interval): CubicalTerm {
  const kept: CubicalTerm = { t: "papp", path: p, at: r }
  if (p.t === "plam") {
    const body = p.body
    return normalize(substIntervalIn(body, r, 0))
  } else if (p.t === "loop") {
    return normalize({ t: "loop-at", at: r })
  } else if (p.t === "pvar") {
    return kept
  } else if (p.t === "base") {
    return kept
  } else if (p.t === "loop-at") {
    return kept
  } else if (p.t === "app") {
    return kept
  } else if (p.t === "circ-rec") {
    return kept
  } else if (p.t === "papp") {
    return kept
  } else {
    return kept
  }
}

export function ap(fun: CubicalTerm, path: CubicalTerm): CubicalTerm {
  return normalize({ t: "plam", body: { t: "app", fun: fun, arg: { t: "papp", path: path, at: { t: "ivar", index: 0 } } } })
}

export function equal(a: CubicalTerm, b: CubicalTerm): boolean {
  return termKey(normalize(a)) === termKey(normalize(b))
}

export function intervalKey(r: Interval): string {
  if (r.t === "i0") {
    return "i0"
  } else if (r.t === "i1") {
    return "i1"
  } else {
    const index = r.index
    return `iv${index}`
  }
}

export function termKey(term: CubicalTerm): string {
  if (term.t === "pvar") {
    const index = term.index
    return `pv${index}`
  } else if (term.t === "base") {
    return "base"
  } else if (term.t === "loop") {
    return "loop"
  } else if (term.t === "const") {
    const name = term.name
    return `c:${name}`
  } else if (term.t === "loop-at") {
    const at = term.at
    return `loopAt(${intervalKey(at)})`
  } else if (term.t === "app") {
    const fun = term.fun
    const arg = term.arg
    return `app(${termKey(fun)},${termKey(arg)})`
  } else if (term.t === "circ-rec") {
    const point = term.point
    const loop = term.loop
    return `circRec(${termKey(point)},${termKey(loop)})`
  } else if (term.t === "plam") {
    const body = term.body
    return `plam(${termKey(body)})`
  } else {
    const path = term.path
    const at = term.at
    return `papp(${termKey(path)},${intervalKey(at)})`
  }
}

export function makeBase(): CubicalTerm {
  return __termVariantBase
}

export function makeLoop(): CubicalTerm {
  return __termVariantLoop
}

export function makeConstant(name: string): CubicalTerm {
  return { t: "const", name: name }
}

export function makeCircRec(point: CubicalTerm, loopImage: CubicalTerm): CubicalTerm {
  return { t: "circ-rec", point: point, loop: loopImage }
}

export function makeReflPath(point: CubicalTerm): CubicalTerm {
  return { t: "plam", body: point }
}
