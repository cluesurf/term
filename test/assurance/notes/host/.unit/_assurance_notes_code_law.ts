const __termVariantLiveEnd = Object.freeze({ form: "live-end" as const })

const __termVariantClean = Object.freeze({ form: "clean" as const })

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

export type Allowed =
  | { form: "as-admin"; i: Natural; w: Natural }
  | { form: "as-owner"; w: Natural; r: Rank }

export type Settles =
  | { form: "hit"; at: Natural; whose: Natural; doer: Person; allowedBy: Allowed }
  | { form: "keep"; at: Natural; whose: Natural; doer: Person; aim: Natural }
  | { form: "still"; at: Natural; whose: Natural; by: Person; doer: Person; aim: Natural }

export type Crosses =
  | { form: "cross-end"; doer: Person; aim: Natural }
  | { form: "cross-on"; top: Note; rest: Shelf; doer: Person; aim: Natural; topAfter: Note; restAfter: Shelf; one: Settles; others: Crosses }

export type Steps =
  | { form: "wrote"; before: Shelf; i: Natural; r: Rank; aim: Natural }
  | { form: "erased"; before: Shelf; doer: Person; aim: Natural; afterErase: Shelf; crossing: Crosses }

export type Replays =
  | { form: "from-start" }
  | { form: "then"; last: Event; sooner: Events; was: Shelf; now: Shelf; reached: Replays; stepped: Steps }

export type Shows =
  | { form: "show-end"; doer: Person }
  | { form: "show-own"; at: Natural; w: Natural; r: Rank; rest: Shelf; shown: Shelf; others: Shows }
  | { form: "show-skip"; n: Note; rest: Shelf; doer: Person; shown: Shelf; others: Shows }

export type AllLive =
  | { form: "live-end" }
  | { form: "live-on"; at: Natural; whose: Natural; rest: Shelf; restLive: AllLive }

export type Owned =
  | { form: "owned-end"; doer: Person }
  | { form: "owned-live"; at: Natural; w: Natural; r: Rank; rest: Shelf; restOwned: Owned }
  | { form: "owned-gone"; at: Natural; w: Natural; r: Rank; by: Person; rest: Shelf; restOwned: Owned }

export function deletedStaysGone(s: Shelf, viewer: Person, v: Shelf, seen: Shows): AllLive {
  if (seen.form === "show-end") {
    return __termVariantLiveEnd
  } else if (seen.form === "show-own") {
    const at = seen.at
    const w = seen.w
    const r = seen.r
    const rest = seen.rest
    const shown = seen.shown
    const others = seen.others
    return { form: "live-on", at: at, whose: w, rest: shown, restLive: deletedStaysGone(rest, { id: w, rank: r }, shown, others) }
  } else {
    const rest = seen.rest
    const doer = seen.doer
    const shown = seen.shown
    const others = seen.others
    return deletedStaysGone(rest, doer, shown, others)
  }
}

export function isolation(s: Shelf, viewer: Person, v: Shelf, seen: Shows): Owned {
  if (seen.form === "show-end") {
    const doer = seen.doer
    return { form: "owned-end", doer: doer }
  } else if (seen.form === "show-own") {
    const at = seen.at
    const w = seen.w
    const r = seen.r
    const rest = seen.rest
    const shown = seen.shown
    const others = seen.others
    return { form: "owned-live", at: at, w: w, r: r, rest: shown, restOwned: isolation(rest, { id: w, rank: r }, shown, others) }
  } else {
    const rest = seen.rest
    const doer = seen.doer
    const shown = seen.shown
    const others = seen.others
    return isolation(rest, doer, shown, others)
  }
}

export type Fair =
  | { form: "fresh"; at: Natural; whose: Natural }
  | { form: "buried"; at: Natural; whose: Natural; by: Person; allowedBy: Allowed }

export type FairShelf =
  | { form: "clean" }
  | { form: "also"; top: Note; rest: Shelf; topFair: Fair; restFair: FairShelf }

export function ownership(es: Events, s: Shelf, run: Replays): FairShelf {
  if (run.form === "from-start") {
    return __termVariantClean
  } else {
    const last = run.last
    const sooner = run.sooner
    const was = run.was
    const now = run.now
    const reached = run.reached
    const stepped = run.stepped
    return ownershipCarry(was, now, ownershipStep(was, last, now, stepped), ownership(sooner, was, reached))
  }
}

export function ownershipCarry(a: Shelf, b: Shelf, keep: (a0: FairShelf) => FairShelf, x: FairShelf): FairShelf {
  return keep(x)
}

export function ownershipStep(s: Shelf, e: Event, t: Shelf, st: Steps): (a0: FairShelf) => FairShelf {
  if (st.form === "wrote") {
    const before = st.before
    const i = st.i
    const aim = st.aim
    return (ok: FairShelf) => ({ form: "also", top: { form: "live", at: aim, whose: i }, rest: before, topFair: { form: "fresh", at: aim, whose: i }, restFair: ok })
  } else {
    const before = st.before
    const doer = st.doer
    const aim = st.aim
    const afterErase = st.afterErase
    const crossing = st.crossing
    return ownershipCross(before, doer, aim, afterErase, crossing)
  }
}

export function ownershipCross(s: Shelf, actor: Person, id: Natural, t: Shelf, c: Crosses): (a0: FairShelf) => FairShelf {
  if (c.form === "cross-end") {
    return (ok: FairShelf) => (__termVariantClean)
  } else {
    const top = c.top
    const rest = c.rest
    const doer = c.doer
    const aim = c.aim
    const topAfter = c.topAfter
    const restAfter = c.restAfter
    const one = c.one
    const others = c.others
    return ownershipJoin(top, rest, topAfter, restAfter, ownershipSettle(top, doer, aim, topAfter, one), ownershipCross(rest, doer, aim, restAfter, others))
  }
}

export function ownershipJoin(a: Note, r: Shelf, a2: Note, r2: Shelf, keepTop: (a0: Fair) => Fair, keepRest: (a0: FairShelf) => FairShelf): (a0: FairShelf) => FairShelf {
  return (ok: FairShelf) => (ownershipApply(a, r, a2, r2, ownershipSplit(a, r, a2, r2, ok), keepTop, keepRest))
}

export function ownershipSplit(a: Note, r: Shelf, a2: Note, r2: Shelf, ok: FairShelf): (a0: (a0: Fair) => Fair, a1: (a0: FairShelf) => FairShelf) => FairShelf {
  ;{
    const top = ok.top
    const rest = ok.rest
    const topFair = ok.topFair
    const restFair = ok.restFair
    return (keepTop: (a0: Fair) => Fair, keepRest: (a0: FairShelf) => FairShelf) => (ownershipBuild(top, rest, a2, r2, keepTop, keepRest, topFair, restFair))
  }
}

export function ownershipBuild(a: Note, r: Shelf, a2: Note, r2: Shelf, keepTop: (a0: Fair) => Fair, keepRest: (a0: FairShelf) => FairShelf, topWas: Fair, restWas: FairShelf): FairShelf {
  return { form: "also", top: a2, rest: r2, topFair: keepTop(topWas), restFair: keepRest(restWas) }
}

export function ownershipApply(a: Note, r: Shelf, a2: Note, r2: Shelf, join: (a0: (a0: Fair) => Fair, a1: (a0: FairShelf) => FairShelf) => FairShelf, keepTop: (a0: Fair) => Fair, keepRest: (a0: FairShelf) => FairShelf): FairShelf {
  return join(keepTop, keepRest)
}

export function ownershipSettle(n: Note, actor: Person, id: Natural, m: Note, st: Settles): (a0: Fair) => Fair {
  if (st.form === "hit") {
    const at = st.at
    const whose = st.whose
    const doer = st.doer
    const allowedBy = st.allowedBy
    return (ok: Fair) => ({ form: "buried", at: at, whose: whose, by: doer, allowedBy: allowedBy })
  } else if (st.form === "keep") {
    const at = st.at
    const whose = st.whose
    return (ok: Fair) => (ok)
  } else {
    const at = st.at
    const whose = st.whose
    const by = st.by
    return (ok: Fair) => (ok)
  }
}
