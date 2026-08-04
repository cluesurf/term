// Side-effect subscriptions on the query graph: run `effect(value)` whenever a watched query's VALUE changes. This is
// the push layer on top of the pull-based incremental compiler -- the one thing a query graph does not give for free
// (reacting to a change with a side effect, e.g. writing a stylesheet to disk, posting to a service, logging).
//
// It does NOT rearchitect anything. The watched query stays pure and memoized; the effect runs imperatively, OUTSIDE
// the query, and only when the value actually changed. Backdating in the query layer does the heavy lifting: an
// unrelated edit leaves the watched value structurally equal, so re-evaluation is a cheap memo hit and the effect does
// not fire. Drive it with `flush()` after a batch of edits (a file save in watch mode). See
// note/library/face/tailwind-jit.md.

import { Database } from '@term/make/code/compile/query'
import type { Cx, Equals } from '@term/make/code/compile/query'

// the default change test is STRUCTURAL, not reference (`Object.is`). Query results are usually arrays / records built
// fresh each run, so a reference compare would fire the effect on every flush (a footgun). Structural compare matches
// how the query layer itself backdates, so the effect fires only on a real value change. Pass a custom `equals` for a
// cheaper or domain-specific test.
function structuralEquals<T>(a: T, b: T): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

type Subscription<T> = {
  query: (cx: Cx) => Promise<T> | T
  effect: (value: T) => void
  equals: Equals<T>
  last: { value: T } | undefined
}

export class Subscriptions {
  private readonly db: Database
  private readonly subs = new Set<Subscription<unknown>>()

  constructor(db: Database) {
    this.db = db
  }

  // watch a query; `effect` runs on the first value and on every later change. Returns an unsubscribe handle.
  on<T>(
    query: (cx: Cx) => Promise<T> | T,
    effect: (value: T) => void,
    equals: Equals<T> = structuralEquals,
  ): () => void {
    const sub: Subscription<T> = {
      query,
      effect,
      equals,
      last: undefined,
    }

    this.subs.add(sub as Subscription<unknown>)

    return () => {
      this.subs.delete(sub as Subscription<unknown>)
    }
  }

  // re-evaluate every subscription and fire the effects whose value changed (including the first time). Call after a
  // batch of `setInput` edits. Returns how many effects fired. Re-evaluation is cheap when nothing relevant changed
  // (the query is memoized + backdated), so calling this on every edit is fine.
  async flush(): Promise<number> {
    let fired = 0

    for (const sub of this.subs) {
      const value = await this.db.transaction(cx => sub.query(cx))

      if (!sub.last || !sub.equals(sub.last.value, value)) {
        sub.last = { value }
        sub.effect(value)
        fired++
      }
    }

    return fired
  }
}
