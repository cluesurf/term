// The roll: everything a build knows about every deck, as data. Built from the checked program after the passes
// that know the raise sets, so every task and route carries the exceptions it can raise. `term roll` prints it,
// `term make` writes it beside the output as `host/roll.json`, and the hive wakes with it at boot.
// See note/project/term/hive/02-roll.md. Pure over the program.
//
// The roll is Term, compile/rolling.tree, its entries an ordered JSON value so that what a build writes, what a merge
// reads back from disk and what `term roll` prints keep their keys in order. compile/rolling-plain.tree turns that value
// into plain objects and back (item term-self-host-001-0080). This face asks check/effects for the raise sets, and hands
// in `===` for the supervision walk, which keys its trees by the call that made each, and the host's `undefined`, the
// value a key holding nothing reads back as. Why each field is there: compile/rolling.tree's header.

import type { Expression, Program, Statement } from '@term/make/code/compile/node'
import { raiseSetsOf } from '@term/make/code/check/effects'
import * as rolling from '@term/make/code/compile/rolling'
import * as plain from '@term/make/code/compile/rolling-plain'

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
  // the docks the route lowering took out of the program (compile.ts `lowerRoutes`): every page route, rolled as the
  // program's own docks are, so the wake tells it and `routes-of` answers it (seam-0018, seam-0025)
  docks?: Statement[]
}

const toRoll = (roll: Roll): rolling.RollKind[] => plain.rollKindsOf(roll)

const fromRoll = (kinds: rolling.RollKind[]): Roll => plain.plainRoll(kinds, undefined) as Roll

// a definition's identity across builds: its file and where it starts, which no other definition shares
export function definitionOf(s: Program[number], file: string): string {
  return rolling.definitionOf(s, file)
}

// the deck a file belongs to, from its path, when nothing better is known
export function deckFromPath(file: string): string {
  return rolling.deckFromPath(file)
}

export function buildRoll(program: Program, file: string, options?: RollOptions): Roll {
  const deckOf = options?.deckOf
  const kinds = rolling.buildRoll(
    program,
    file,
    // the two optional fields as Term holds a `need false` maybe: the value itself, or absent
    {
      own: options?.own ? new Map([...options.own].map(name => [name, true])) : undefined,
      root: options?.root,
      ids: options?.ids === true,
      docks: options?.docks,
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
// roll at once: @term/bind's 3,091 rolls held together ran the main thread out of its 4 GB heap (2026-10-05)
export function makeRollMerger(): { add: (roll: Roll) => void; done: () => Roll } {
  const merger = rolling.makeRollMerger()

  return {
    add: roll => rolling.mergeRoll(merger, toRoll(roll)),
    done: () => fromRoll(rolling.finishMerge(merger)),
  }
}

// the roll as a tree, the way `term roll` prints it. `path`: under each exception, one call path per task that can
// raise it (`term roll exception --path`), and under each task the path to each exception it raises
export function showRoll(roll: Roll, kind?: string, options?: { path?: boolean }): string {
  return rolling.showRoll(toRoll(roll), kind ?? '', options?.path === true)
}
