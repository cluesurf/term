const __termVariantYes = Object.freeze({ form: "yes" as const })

const __termVariantNo = Object.freeze({ form: "no" as const })

const __termVariantBare = Object.freeze({ form: "bare" as const })

export type Natural =
  | { form: "zero" }
  | { form: "succ"; prior: Natural }

export type Rank =
  | { form: "admin" }
  | { form: "member" }

export interface Person {
  id: Natural
  rank: Rank
}

export type Note =
  | { form: "live"; at: Natural; whose: Natural }
  | { form: "gone"; at: Natural; whose: Natural; by: Person }

export type Shelf =
  | { form: "bare" }
  | { form: "more"; top: Note; rest: Shelf }

export type Event =
  | { form: "write"; actor: Person; id: Natural }
  | { form: "erase"; actor: Person; id: Natural }

export type Events =
  | { form: "begin" }
  | { form: "after"; event: Event; earlier: Events }

export type Flag =
  | { form: "yes" }
  | { form: "no" }

export function either(a: Flag, b: Flag): Flag {
  if (a.form === "yes") {
    return __termVariantYes
  } else {
    return b
  }
}

export function same(a: Natural, b: Natural): Flag {
  while (true) {
    if (a.form === "zero") {
      if (b.form === "zero") {
        return __termVariantYes
      } else {
        return __termVariantNo
      }
    } else {
      const p = a.prior
      if (b.form === "zero") {
        return __termVariantNo
      } else {
        const q = b.prior
        const __tail0_0: Natural = p
        const __tail0_1: Natural = q
        a = __tail0_0
        b = __tail0_1
        continue
      }
    }
  }
}

export function isAdmin(r: Rank): Flag {
  if (r.form === "admin") {
    return __termVariantYes
  } else {
    return __termVariantNo
  }
}

export function may(actor: Person, owner: Natural): Flag {
  return either(isAdmin(actor.rank), same(actor.id, owner))
}

export function step(s: Shelf, e: Event): Shelf {
  if (e.form === "write") {
    const actor = e.actor
    const id = e.id
    return { form: "more", top: { form: "live", at: id, whose: actor.id }, rest: s }
  } else {
    const actor = e.actor
    const id = e.id
    return cross(s, actor, id)
  }
}

export function cross(s: Shelf, actor: Person, id: Natural): Shelf {
  if (s.form === "bare") {
    return __termVariantBare
  } else {
    const top = s.top
    const rest = s.rest
    return { form: "more", top: settle(top, actor, id), rest: cross(rest, actor, id) }
  }
}

export function settle(n: Note, actor: Person, id: Natural): Note {
  if (n.form === "live") {
    const at = n.at
    const whose = n.whose
    return aim(same(at, id), at, whose, actor)
  } else {
    return n
  }
}

export function aim(f: Flag, at: Natural, whose: Natural, actor: Person): Note {
  if (f.form === "yes") {
    return guard(may(actor, whose), at, whose, actor)
  } else {
    return { form: "live", at: at, whose: whose }
  }
}

export function guard(g: Flag, at: Natural, whose: Natural, actor: Person): Note {
  if (g.form === "yes") {
    return { form: "gone", at: at, whose: whose, by: actor }
  } else {
    return { form: "live", at: at, whose: whose }
  }
}

export function replay(es: Events): Shelf {
  if (es.form === "begin") {
    return __termVariantBare
  } else {
    const event = es.event
    const earlier = es.earlier
    return step(replay(earlier), event)
  }
}

export function view(s: Shelf, viewer: Person): Shelf {
  if (s.form === "bare") {
    return __termVariantBare
  } else {
    const top = s.top
    const rest = s.rest
    return pick(top, viewer, view(rest, viewer))
  }
}

export function pick(n: Note, viewer: Person, shown: Shelf): Shelf {
  if (n.form === "live") {
    const whose = n.whose
    return show(same(whose, viewer.id), n, shown)
  } else {
    return shown
  }
}

export function show(f: Flag, n: Note, shown: Shelf): Shelf {
  if (f.form === "yes") {
    return { form: "more", top: n, rest: shown }
  } else {
    return shown
  }
}
