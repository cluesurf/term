// The roll: everything a build knows about every deck, as data. Built from the checked program after the passes
// that know the raise sets, so every task and route carries the exceptions it can raise. `term roll` prints it,
// `term make` writes it beside the output as `host/roll.json`, and the hive wakes with it at boot.
// See note/term/hive/02-roll.md. Pure over the program.
//
// The roll is Term, compile/rolling.tree (self-hosting, 2026-10-06), its entries an ordered JSON value so that what a
// build writes, what a merge reads back from disk and what `term roll` prints keep their keys in order. This face
// converts between that value and plain objects, asks check/effects for the raise sets, and hands in `===` for the
// supervision walk, which keys its trees by the call that made each. Why each field is there:
//   - `site` is relative to the deck that owns the file, else to the project root, and counted from one, as every
//     error frame counts (it printed zero-based numbers until 2026-10-04)
//   - a type and a task's name are written without the suffix a split by file or by arity gives them (`__in0_1`,
//     `__3__0`), which depends on what else the program holds, so the roll printed one definition two ways
//   - `failure` is always asked for: a native shim raises it by construction, and the program holds its form only when
//     the closure kept it (task/term/roll-cover.ts, 2026-10-05)
//   - a unit (`own`) lists only its own definitions and counts no deck, and `ids` marks what a merge reads and then
//     drops: `__def`, a definition's identity, `__ends`, the definition each raise path ends at, and a deck's `__files`
//   - THE SUPERVISION TREES: every `make-supervisor` with its strategy, limits, children and WORST CASE, the workers
//     under a supervisor restarting `intensity × Π (ancestor intensity + 1)` times before the root stops. OTP computes
//     this nowhere (note/term/research/beam-otp-lessons.md, design 4)
//   - a merge keys an entry by host, kind, name AND site, since a name is scoped to its module
//     (task/term/roll-cover.ts, 2026-10-05), counts a deck's files as their union, continues a path a unit ended at
//     another unit's task, and sorts each kind by host, name and site so a pool's merge reads like a single thread's

import type { Expression, Program } from '@term/make/code/compile/node'
import { raiseSetsOf } from '@term/make/code/check/effects'
import * as rolling from '@term/make/code/compile/rolling'

export type RollEntry = {
  host: string
  kind: string
  name: string
  site: string
} & Record<string, unknown>

export type Roll = {
  deck: RollEntry[]
  exception: RollEntry[]
  task: RollEntry[]
  dock: RollEntry[]
  tell: RollEntry[]
  // a kind a deck declares with `roll <name>` (07-kind.md): one entry per declaration, and the kind's own entries
  // (every top-level constant of its form) under the kind's name beside the built-in ones
  kind: RollEntry[]
  [declared: string]: RollEntry[]
}

// the deck a source file belongs to: its name (`@term/base`) and its root directory, from the nearest `deck.tree`
export type DeckOf = (file: string) => { name: string; root: string } | undefined

export type RollOptions = {
  // absent means the deck is read off the path (`.../link/@scope/name/...`), and `@local` for the entry's own files
  deckOf?: DeckOf
  // the project root, so a `site` under it is a path relative to it
  root?: string
  // a separate unit's own files: only their definitions are listed, the rest being stubs another unit lists, and no
  // deck is counted, since a deck's files are the build's (call/code/roll.ts `projectRoll`)
  own?: Set<string>
  // mark each entry with what a merge reads and then drops (`makeRollMerger`). A roll that goes anywhere else, the
  // hive's wake, carries none
  ids?: boolean
}

// ---- the value, both ways ----

function toValue(value: unknown): rolling.RollValue {
  if (value === undefined) {
    return { form: 'no-value' }
  }

  if (value === null) {
    return { form: 'null-value' }
  }

  if (typeof value === 'string') {
    return { form: 'text-value', value }
  }

  if (typeof value === 'number') {
    return { form: 'number-value', value }
  }

  if (typeof value === 'boolean') {
    return { form: 'flag-value', value }
  }

  if (Array.isArray(value)) {
    return { form: 'item-values', values: value.map(toValue) }
  }

  return {
    form: 'pair-values',
    pairs: Object.entries(value as Record<string, unknown>).map(([key, inner]) => ({ key, value: toValue(inner) })),
  }
}

function fromValue(value: rolling.RollValue): unknown {
  switch (value.form) {
    case 'no-value':
      return undefined
    case 'null-value':
      return null
    case 'text-value':
    case 'number-value':
    case 'flag-value':
      return value.value
    case 'item-values':
      return value.values.map(fromValue)
    case 'pair-values': {
      const out: Record<string, unknown> = {}

      for (const pair of value.pairs) {
        out[pair.key] = fromValue(pair.value)
      }

      return out
    }
  }
}

function toRoll(roll: Roll): rolling.RollKind[] {
  return Object.entries(roll).map(([name, entries]) => ({ name, entries: (entries ?? []).map(toValue) }))
}

function fromRoll(kinds: rolling.RollKind[]): Roll {
  const out: Record<string, RollEntry[]> = {}

  for (const kind of kinds) {
    out[kind.name] = kind.entries.map(fromValue) as RollEntry[]
  }

  return out as Roll
}

// ---- the roll ----

// a definition's identity across builds: its file and where it starts, which no other definition shares
export function definitionOf(s: Program[number], file: string): string {
  return rolling.definitionOf(s, file)
}

// the deck a file belongs to, from its path, when nothing better is known
export function deckFromPath(file: string): string {
  return rolling.deckFromPath(file)
}

export function buildRoll(
  program: Program,
  file: string,
  options?: RollOptions,
): Roll {
  const deckOf = options?.deckOf
  const kinds = rolling.buildRoll(
    program,
    file,
    // the two optional fields as Term holds a `need false` maybe: the value itself, or absent
    {
      own: options?.own ? new Map([...options.own].map(name => [name, true])) : undefined,
      root: options?.root,
      ids: options?.ids === true,
    } as never,
    path => {
      const deck = deckOf?.(path)

      return deck ? { form: 'some', value: { name: deck.name, root: deck.root } } : { form: 'none' }
    },
    names => raiseSetsOf(program, names),
    (left: Expression, right: Expression) => left === right,
  )

  return fromRoll(kinds)
}

// merge several rolls (one per compiled entry) into one, deduplicating entries by host, kind, name and site
export function mergeRolls(rolls: Roll[]): Roll {
  const merger = makeRollMerger()

  for (const roll of rolls) {
    merger.add(roll)
  }

  return merger.done()
}

// the merge one roll at a time, the first entry of each name kept, so a caller holds the merged roll and never every
// roll at once. Every entry's roll covers its whole closure, and @term/bind's 3,091 of them held together ran the
// main thread out of its 4 GB heap after a cold build (2026-10-05)
export function makeRollMerger(): { add: (roll: Roll) => void; done: () => Roll } {
  const merger = rolling.makeRollMerger()

  return {
    add: roll => rolling.mergeRoll(merger, toRoll(roll)),
    done: () => fromRoll(rolling.finishMerge(merger)),
  }
}

// the roll as a tree, the way `term roll` prints it
export function showRoll(
  roll: Roll,
  kind?: string,
  // `path`: under each exception, one call path per task that can raise it (`term roll exception --path`), and
  // under each task the path to each exception it raises
  options?: { path?: boolean },
): string {
  return rolling.showRoll(toRoll(roll), kind ?? '', options?.path === true)
}
