// Runtime shim for the font-ready registry (the FOUC-prevention typography layer). Wraps the browser
// `document.fonts` FontFaceSet so the `.tree` side never expresses FontFaceSet loading directly. Provided to
// Seed via <global:fontset> (docked `name fontset`, so this object IS the binding); the dom calls
// `fontset.check` / `fontset.watch`. A namespace object (not top-level functions) so the bundled client has no
// name collisions, matching the resize / position runtimes. Named `fontset` (one identifier, like `resize`)
// because a `<global:X>` tag is emitted verbatim as the binding identifier — a hyphen would be invalid JS.
//
// Two operations, because the visibility gate needs both a synchronous "is it ALREADY loaded" answer (warm cache
// -> render at full opacity with no hidden frame) and an async "tell me WHEN it resolves" callback (cold load ->
// hide, then reveal):
//
//   check(family)      -> boolean. Synchronous. True iff the family is loaded and usable RIGHT NOW.
//   watch(family, cb)  -> void.    Resolves the family's load status and calls `cb(status)` exactly once with a
//                                  terminal status ('ready' | 'error' | 'timeout'). A hard timeout guarantees `cb`
//                                  always fires so text is never stuck hidden.

const TIMEOUT_MS = 2000

type FontStatus = 'ready' | 'error' | 'timeout'

// Per-family deadline state (Layer A of the visibility machine). One shared timer per family fires at
// `firstAsk + thresholdMs` and wakes every subscriber on the same tick, so a page with N text nodes of one family
// keeps a single setTimeout, not N. Matches React's `subscribeToFontDeadline`: the FIRST subscriber's threshold
// schedules the timer; once fired, a late subscriber fires on the next microtask.
const firstAskAtByFamily = new Map<string, number>()
const deadlineFiredByFamily = new Set<string>()
const deadlineSubscribersByFamily = new Map<string, Set<() => void>>()
const deadlineTimerByFamily = new Map<
  string,
  ReturnType<typeof setTimeout>
>()

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

// A CSS font shorthand that names the family. `document.fonts.check` / `.load` need a font shorthand, not a bare
// family name; `1em "<family>"` is the minimal valid one.
function shorthand(family: string): string {
  return `1em "${family}"`
}

export const fontset = {
  // Synchronous: is this family loaded and ready to paint right now? On the server (no FontFaceSet) or for an
  // empty family, report true so text is never hidden where there is nothing to wait for.
  check(family: string): boolean {
    if (typeof document === 'undefined' || !document.fonts || !family) {
      return true
    }
    try {
      return document.fonts.check(shorthand(family))
    } catch {
      // check() throws on a malformed shorthand; treat as "not blocking" rather than hiding text forever.
      return true
    }
  },

  // Async: call `cb` once with the terminal status. `document.fonts.load` forces the family to load and resolves
  // with the matched FontFace list; a timeout backstops a never-resolving load. SSR / no FontFaceSet reports ready.
  watch(family: string, cb: (status: FontStatus) => void): void {
    if (typeof document === 'undefined' || !document.fonts || !family) {
      cb('ready')
      return
    }

    let settled = false
    const done = (status: FontStatus): void => {
      if (settled) {
        return
      }
      settled = true
      cb(status)
    }

    const timer = setTimeout(() => done('timeout'), TIMEOUT_MS)

    document.fonts.load(shorthand(family)).then(
      faces => {
        clearTimeout(timer)
        done(faces.length > 0 ? 'ready' : 'error')
      },
      () => {
        clearTimeout(timer)
        done('error')
      },
    )
  },

  // Fallback deadline: call `cb` once when `firstAsk + thresholdMs` elapses for this family, regardless of load
  // status, so the visibility machine can reveal the fallback face if the real font is slow. One shared timer per
  // family (the FIRST subscriber schedules it); a subscriber arriving after the deadline already fired is called on
  // the next microtask. SSR / no window: never fires (the client re-render drives the real gate).
  deadline(family: string, thresholdMs: number, cb: () => void): void {
    if (typeof window === 'undefined' || !family) {
      return
    }

    if (!firstAskAtByFamily.has(family)) {
      firstAskAtByFamily.set(family, nowMs())
    }

    // Already fired: fire async so every path is uniformly asynchronous.
    if (deadlineFiredByFamily.has(family)) {
      Promise.resolve().then(cb)
      return
    }

    let subscribers = deadlineSubscribersByFamily.get(family)
    if (!subscribers) {
      subscribers = new Set()
      deadlineSubscribersByFamily.set(family, subscribers)
    }
    subscribers.add(cb)

    // Schedule the family-wide timer on the first subscribe.
    if (!deadlineTimerByFamily.has(family)) {
      const firstAsk = firstAskAtByFamily.get(family) ?? nowMs()
      const remaining = Math.max(0, firstAsk + thresholdMs - nowMs())
      const id = setTimeout(() => {
        deadlineFiredByFamily.add(family)
        deadlineTimerByFamily.delete(family)
        const subs = deadlineSubscribersByFamily.get(family)
        if (!subs) {
          return
        }
        // Snapshot before iterating: a subscriber may mutate the set inside its callback.
        for (const sub of Array.from(subs)) {
          try {
            sub()
          } catch (error) {
            console.error(
              `[fontset] deadline subscriber for "${family}" threw`,
              error,
            )
          }
        }
      }, remaining)
      deadlineTimerByFamily.set(family, id)
    }
  },
}
