// `term roll [kind]` -- the roll of this project: every deck in the build, every exception with who can raise it,
// every public task with what it raises, every route, every tell. Recomputed from source, so never stale. Prints as
// a tree; `--json` prints the same shape `term make` writes to host/roll.json. See note/term/hive/08-cli.md.

import { readFileSync } from 'fs'
import path from 'path'
import { compile } from '@term/make/code/compile/compile'
import { compileSeparate } from '@term/make/code/compile/separate'
import type { Roll } from '@term/make/code/compile/roll'
import { projectDeckOf } from '@term/call/code/deck-of'
import { projectRoleOf, projectLeanOf } from '@term/call/code/role-of'
import { deckFromPath, makeRollMerger, showRoll } from '@term/make/code/compile/roll'
import { buildable, buildSession, findTreeFiles, isWholeFile, unitSlug } from '@term/call/code/make'
import type { BuildProblem } from '@term/call/code/make'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { projectCache } from '@term/call/code/cache-store'
import { closeRun, count, field, location, openRun, outputOptions, printData, report, reportProblems } from '@term/call/code/output'
import { addReach, diffRolls, ownHost, reachGains, rollBefore } from '@term/call/code/roll-diff'

export const ROLL_KINDS = ['deck', 'exception', 'task', 'dock', 'tell', 'kind', 'supervision']

// THE ROLL OF THE BUILD: every definition of every module the project's entries load, each typed once in its own
// unit's build (compile/roll.ts `own`) and kept with the unit, so a module's part changes only when the module does.
// It prints nothing: a file that does not compile is in `failed`, and its diagnostics in `problems` for the caller to
// report (`term roll` draws them; `term make` has reported the same ones from its own build already).
//
// It was the merge of every entry's own roll, each read off the entry's program once shaken (ir/prune.ts), and that
// made it a function of which entry reached what: the shake keeps a definition any name in kept code happens to
// spell, a task's raises and its inferred types changed with what else the entry loaded, and the merge kept whichever
// entry sorted first (task/term/roll-cover.ts found 17 names on zone two entries gave different entries). And it cost a
// typing of every entry's closure: 481 to 641 s of a cold @term/bind's workers (2026-10-05). Now a unit's definition
// has one entry, whoever loads it, and a definition is on the roll when its module is in the build.
//
// `rolls`, from the build just run (`compileProjectSeparate`), is each unit's roll by its label. Without it (`term
// roll`, `term make --merged`) each entry is built from units here, from the cache when the build ran, writing nothing.
// task/term/roll-units.ts holds the result to every entry's own roll: every entry it lists, the same where the entries
// agree and one of their answers where they do not
export function projectRoll(root: string, rolls?: Map<string, Roll>): {
  roll: Roll
  failed: string[]
  problems: BuildProblem[]
} {
  const failed: string[] = []
  const problems: BuildProblem[] = []
  // `TERM_ROLL_PROFILE=1` prints where the pass spent its time, to stderr
  const profile = process.env.TERM_ROLL_PROFILE === '1'
  const startedAt = Date.now()
  const units = rolls ?? unitRolls(root, failed, problems)
  const deckOf = projectDeckOf()
  // merged one unit at a time, never all held at once (compile/roll.ts `makeRollMerger`)
  const merger = makeRollMerger()
  // each deck's files: every unit's, labelled by its files joined (compile/separate.ts)
  const decks = new Map<string, string[]>()

  for (const [label, roll] of units) {
    // a copy: the merge joins paths in place, and the unit's roll is the session's, read again next build
    merger.add(relativize(structuredClone(roll), root))

    for (const file of label.split('+')) {
      const host = deckOf(file)?.name ?? deckFromPath(file)
      decks.set(host, [...(decks.get(host) ?? []), file])
    }
  }

  merger.add({
    deck: [...decks].map(([host, files]) => ({ host, kind: 'deck', name: host, site: '', file: files.length, __files: files })),
    exception: [],
    task: [],
    dock: [],
    tell: [],
    kind: [],
  })

  const roll = merger.done()

  if (profile) {
    process.stderr.write(`roll pass: ${Date.now() - startedAt} ms over ${units.size} units\n`)
  }

  return { roll, failed, problems }
}

// every unit's roll of the project's entries, each entry built from units as `term make` builds it, writing nothing: the
// cache answers every unit the last build built. An entry that does not build is in `failed` with its diagnostics
function unitRolls(root: string, failed: string[], problems: BuildProblem[]): Map<string, Roll> {
  const link = path.join(root, 'link') + path.sep
  const files = findTreeFiles(root, [], 'node').filter(f => !f.startsWith(link))
  const session = buildSession(root)
  const cache = projectCache(root)
  const deckOf = projectDeckOf()
  // the role and lean readers, the same ones `term make` compiles with: a lean grammar read long-form reports every
  // property head as an unknown name (lean-0035, 2026-09-12)
  const roleOf = projectRoleOf(root)
  const leanOf = projectLeanOf(root)
  const rolls = new Map<string, Roll>()

  session.turn(files)

  for (const file of files) {
    const unit = buildable(file, readFileSync(file, 'utf8'), roleOf(file))

    if ('faults' in unit) {
      failed.push(path.relative(root, file))
      continue
    }

    // a file that is not a program (a grammar, a data file) has no tasks to list
    if (isWholeFile(file, unit.text, roleOf(file))) {
      continue
    }

    const result = compileSeparate(
      { file, text: unit.text },
      {
        resolve: session.resolve,
        cache,
        modules: f => `./${unitSlug(root, f, deckOf)}`,
        roleOf,
        leanOf,
        deckOf,
        parsed: session.parsed,
        units: session.units,
        walked: session.walked,
      },
    )

    if (!result.ok) {
      failed.push(path.relative(root, file))

      for (const diagnostic of result.diagnostics) {
        problems.push(diagnostic.file === file ? unit.place(diagnostic) : { diagnostic, text: undefined })
      }

      continue
    }

    for (const [label, roll] of result.rolls) {
      rolls.set(label, roll)
    }
  }

  session.close()

  return rolls
}

// one entry's roll, and its diagnostics when it does not build: the whole-program compile the roll is read from, with
// only the roll and the diagnostics cached (compile's `rollOnly`). Called here and by a worker of the parallel build
// (separate-worker.ts), which computes each entry's roll beside its units, under the same key
export type EntryRoll = { ok: boolean; roll?: Roll; diagnostics: Diagnostic[] }

type CompileOptions = NonNullable<Parameters<typeof compile>[1]>

export function entryRoll(source: { file: string; text: string }, options: Omit<CompileOptions, 'roll' | 'rollOnly'>): EntryRoll {
  const one = compile(source, { ...options, roll: true, rollOnly: true })

  return one.ok ? { ok: true, roll: one.roll, diagnostics: [] } : { ok: false, diagnostics: one.diagnostics }
}

// where an entry's roll is kept, by its closure key (`SeparateResult.closureKey`)
export function rollKey(closureKey: string): string {
  return `roll:${closureKey}`
}

// sites relative to the root, so the printed roll reads the same on every machine
function relativize(roll: Roll, root: string): Roll {
  const fix = (site: string): string =>
    site.startsWith(root + '/') ? site.slice(root.length + 1) : site

  for (const kind of Object.keys(roll)) {
    for (const entry of roll[kind] ?? []) {
      entry.site = fix(entry.site)
    }
  }

  return roll
}

export async function callRoll(input: {
  root: string
  kind?: string
  json?: boolean
  private?: boolean
  host?: string
  path?: boolean
  diff?: string
}): Promise<void> {
  openRun({ verb: 'roll', root: input.root, facts: input.kind ? [input.kind] : [] })

  const { roll, failed, problems } = projectRoll(input.root)

  // what each of the project's own tasks can touch, beside what it can raise (call/code/reach.ts)
  addReach(roll, input.root)

  if (input.diff !== undefined) {
    rollDiff({ root: input.root, before: input.diff, roll, failed, problems, json: input.json === true })

    return
  }

  // a kind is built in, or declared by a deck of this build (`roll <name>`)
  if (input.kind && !ROLL_KINDS.includes(input.kind) && !roll.kind.some(k => k.name === input.kind)) {
    const declared = roll.kind.map(k => k.name)
    report({ glyph: 'failed', kind: 'problem', subject: `There is no roll kind named ${input.kind}`, fields: [field('kinds', [...ROLL_KINDS, ...declared].join(', '))] })
    closeRun({ verdict: 'Nothing rolled' })

    return
  }

  if (input.host) {
    for (const kind of Object.keys(roll)) {
      roll[kind] = (roll[kind] ?? []).filter(e => e.host === input.host)
    }
  }

  if (input.private) {
    const told = new Set(roll.tell.map(t => t.name))
    roll.exception = roll.exception.filter(
      e => !told.has(`${e.host}/${e.name}`),
    )
  }

  // which tell covers each exception, and which routes can answer with it
  for (const exception of roll.exception) {
    const full = `${exception.host}/${exception.name}`
    const tell = roll.tell.find(t => t.name === full)
    exception.tell = tell ? tell.note : 'private'
    exception.dock = roll.dock
      .filter(d => (d.halt as string[]).includes(exception.name))
      .map(d => d.name)
  }

  // what was asked for: one kind's entries after `--host` and `--private`, or the whole roll
  const shown: Array<unknown> | undefined = input.kind ? ((roll as unknown as Record<string, unknown[]>)[input.kind] ?? []) : undefined

  // the roll is the answer the user asked for: data on stdout, as a tree or as the JSON `term make` writes. The
  // block alone, ended by one newline: the run's own blank lines already stand before and after it on a terminal,
  // and a kind with no entries writes nothing, so its closing item's `0 routes` is the whole answer
  if (input.json) {
    printData(JSON.stringify(roll, null, 2) + '\n')
  } else if (!shown || shown.length > 0) {
    printData(`${showRoll(roll, input.kind, { path: input.path })}\n`)
  }

  // a file that did not compile is not on the roll: its problems, then a ▲ item naming what is missing, so the
  // roll still answers and says it is partial
  reportProblems(problems, input.root)

  if (failed.length) {
    report({
      glyph: 'warning',
      verb: 'roll',
      subject: `${failed.length} file${failed.length === 1 ? ' did' : 's did'} not compile and ${failed.length === 1 ? 'is' : 'are'} not on the roll`,
      message: [failed.join(', ')],
    })
  }

  // one rule for the closing counts: they count what was printed. A kind counts its own entries, after `--host` and
  // `--private`, so `roll task --host shop` says `4 tasks` and `roll dock` says `0 routes`. With no kind the three
  // totals of the whole (filtered) roll, which is what the per-deck block adds up to
  closeRun({
    verdict: failed.length ? 'Rolled, with files missing' : 'Rolled',
    counts: shown
      ? [count(shown.length, ...rollNoun(input.kind as string))]
      : [
          count(roll.exception.length, 'exceptions', 'exception'),
          count(roll.task.length, 'tasks', 'task'),
          count(roll.dock.length, 'routes', 'route'),
        ],
  })
}

// `--diff <before>`: the roll now against the roll at `before` (call/code/roll-diff.ts). Each task that changed what it
// can reach or raise is an item, a gained reach a warning, so `--strict` fails a change that widened what code can do
function rollDiff(input: { root: string; before: string; roll: Roll; failed: string[]; problems: BuildProblem[]; json: boolean }): void {
  let failedBefore = 0
  const before = rollBefore(input.root, input.before, at => {
    const old = projectRoll(at)

    failedBefore = old.failed.length

    return old.roll
  })

  if ('error' in before) {
    if (input.json) {
      printData(`${JSON.stringify({ error: 'no-before', message: before.error })}\n`)
      process.exitCode = 1

      return
    }

    report({ glyph: 'failed', kind: 'problem', subject: before.error })
    closeRun({ verdict: 'Nothing compared', next: 'term roll --json > before.json, before the change, then term roll --diff before.json' })

    return
  }

  const diff = diffRolls(input.before, before.roll, input.roll, ownHost(input.root))
  const gains = reachGains(diff)

  if (input.json) {
    printData(`${JSON.stringify(diff)}\n`)

    if (gains && outputOptions().strict) {
      process.exitCode = 1
    }

    return
  }

  const list = (items: string[]): string => items.join(', ')

  for (const task of diff.tasks.added) {
    report({
      glyph: task.reach.length ? 'warning' : 'added',
      kind: 'change',
      subject: `New task ${task.name}`,
      fields: [
        location(task.site),
        field('reach', task.reach.length ? list(task.reach) : 'no native module'),
        field('raise', task.halt.length ? list(task.halt) : 'nothing'),
      ],
    })
  }

  for (const task of diff.tasks.changed) {
    report({
      glyph: task.reach.added.length ? 'warning' : 'changed',
      kind: 'change',
      subject: `${task.name} changed what it can do`,
      fields: [
        location(task.site),
        ...(task.reach.added.length ? [field('reaches now', list(task.reach.added))] : []),
        ...(task.reach.removed.length ? [field('reaches no longer', list(task.reach.removed))] : []),
        ...(task.halt.added.length ? [field('raises now', list(task.halt.added))] : []),
        ...(task.halt.removed.length ? [field('raises no longer', list(task.halt.removed))] : []),
        ...(task.async ? [field('async', task.async.after ? 'now' : 'no longer')] : []),
      ],
    })
  }

  for (const task of diff.tasks.removed) {
    report({ glyph: 'removed', kind: 'change', subject: `Task ${task.name} is gone`, fields: [location(task.site)] })
  }

  for (const name of diff.exceptions.added) {
    report({ glyph: 'added', kind: 'change', subject: `New exception ${name}` })
  }

  for (const name of diff.exceptions.removed) {
    report({ glyph: 'removed', kind: 'change', subject: `Exception ${name} is gone` })
  }

  for (const name of diff.routes.added) {
    report({ glyph: 'added', kind: 'change', subject: `New route ${name}` })
  }

  for (const name of diff.routes.removed) {
    report({ glyph: 'removed', kind: 'change', subject: `Route ${name} is gone` })
  }

  for (const route of diff.routes.changed) {
    report({
      glyph: 'changed',
      kind: 'change',
      subject: `Route ${route.name} changed what it can raise`,
      fields: [
        ...(route.halt.added.length ? [field('raises now', list(route.halt.added))] : []),
        ...(route.halt.removed.length ? [field('raises no longer', list(route.halt.removed))] : []),
      ],
    })
  }

  // a deck the project loads, counted rather than listed: its tasks are reached through the project's own, above
  for (const deck of diff.decks) {
    const parts = [
      deck.tasks.added ? `${deck.tasks.added} tasks entered the build` : '',
      deck.tasks.removed ? `${deck.tasks.removed} tasks left it` : '',
      deck.tasks.changed ? `${deck.tasks.changed} tasks changed what they raise` : '',
      deck.exceptions.added ? `${deck.exceptions.added} exceptions entered` : '',
      deck.exceptions.removed ? `${deck.exceptions.removed} exceptions left` : '',
    ].filter(Boolean)

    report({ glyph: 'changed', kind: 'change', subject: `${deck.host}: ${parts.join(', ')}` })
  }

  if (!diff.reach) {
    report({ glyph: 'warning', verb: 'roll', subject: `${input.before} was written before tasks carried their reach, so only raises are compared` })
  }

  reportProblems(input.problems, input.root)

  if (input.failed.length || failedBefore) {
    report({
      glyph: 'warning',
      verb: 'roll',
      subject: `Files that did not compile are not compared: ${input.failed.length} now, ${failedBefore} before`,
      ...(input.failed.length ? { message: [input.failed.join(', ')] } : {}),
    })
  }

  const changes =
    diff.tasks.added.length + diff.tasks.changed.length + diff.tasks.removed.length +
    diff.exceptions.added.length + diff.exceptions.removed.length +
    diff.routes.added.length + diff.routes.removed.length + diff.routes.changed.length + diff.decks.length

  closeRun({
    verdict: changes ? `Compared with ${input.before}` : `Nothing changed since ${input.before}`,
    counts: [
      count(diff.tasks.added.length, 'tasks added', 'task added'),
      count(diff.tasks.changed.length, 'tasks changed', 'task changed'),
      count(diff.tasks.removed.length, 'tasks removed', 'task removed'),
      count(gains, 'gained a native module', 'gained a native module'),
    ],
  })
}

// the noun a kind is counted in, plural then singular. A declared kind's entries are `entries`
function rollNoun(kind: string): [string, string] {
  const nouns: Record<string, [string, string]> = {
    deck: ['decks', 'deck'],
    exception: ['exceptions', 'exception'],
    task: ['tasks', 'task'],
    dock: ['routes', 'route'],
    tell: ['tells', 'tell'],
    kind: ['kinds', 'kind'],
    supervision: ['supervisors', 'supervisor'],
  }

  return nouns[kind] ?? ['entries', 'entry']
}
