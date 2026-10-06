// `term roll --diff <before>`: what a change did to what the project's tasks can DO. For every task, the native
// modules it can reach (call/code/reach.ts) and the exceptions it can raise, before and after, and for the build the
// exceptions and routes that came or went. A reviewer of code they did not write, an agent's or a colleague's, reads
// this before the code: a task that gained `node:child_process` is the line to look at.
//
// `before` is a roll a run wrote (`term roll --json > before.json`), or a git ref, whose tree is read with
// `git archive` into the project's `tmp/` under the commit it names and rolled there with the project's own `link/`.
// Reading a ref writes nothing to the repository. A gained reach is a warning, so `--strict` makes the diff a gate.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import type { Roll, RollEntry } from '@term/make/code/compile/roll'
import { projectDeckOf } from '@term/call/code/deck-of'
import { reachGraph, siteFile } from '@term/call/code/reach'

// every task of the project's own deck with the native modules it can reach, as `reach`, sorted. A dependency's task
// is left as it is: what a deck the project loads can do is that deck's roll, and its tasks are reached through the
// project's own
export function addReach(roll: Roll, root: string): void {
  const own = projectDeckOf()(path.join(root, 'deck.tree'))
  const host = ownHost(root)
  const base = own?.root ?? root
  const graph = reachGraph(root)

  for (const task of roll.task) {
    if (task.host !== host) {
      continue
    }

    const at = siteFile(base, task.site)

    task.reach = at ? graph.reachAt(at.file, at.line) : []
  }
}

export type RollDiff = {
  before: string
  // the deck whose tasks are compared one by one: the project's own
  host: string
  tasks: {
    added: { name: string; site: string; reach: string[]; halt: string[] }[]
    removed: { name: string; site: string }[]
    changed: {
      name: string
      site: string
      reach: { added: string[]; removed: string[] }
      halt: { added: string[]; removed: string[] }
      async?: { before: boolean; after: boolean }
    }[]
  }
  exceptions: { added: string[]; removed: string[] }
  routes: {
    added: string[]
    removed: string[]
    changed: { name: string; halt: { added: string[]; removed: string[] } }[]
  }
  // every other deck of the build whose part changed, counted: a deck the project newly loads brings its whole roll,
  // and what the PROJECT'S tasks can now do is already in `tasks`, which is what reaches those decks
  decks: { host: string; tasks: { added: number; removed: number; changed: number }; exceptions: { added: number; removed: number } }[]
  // false when the earlier roll was written before tasks carried their reach, so only raises could be compared
  reach: boolean
}

// the project's own deck, as its tasks are listed on the roll
export function ownHost(root: string): string {
  return projectDeckOf()(path.join(root, 'deck.tree'))?.name ?? '@local'
}

// a roll as it stood at `before`: a JSON file a run wrote, else a git ref, rolled where its tree is read out
export function rollBefore(
  root: string,
  before: string,
  roll: (root: string) => Roll,
): { roll: Roll } | { error: string } {
  const file = path.resolve(root, before)

  if (existsSync(file) && before.endsWith('.json')) {
    try {
      return { roll: JSON.parse(readFileSync(file, 'utf8')) as Roll }
    } catch (error) {
      return { error: `${before} is not a roll: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  const git = (args: string[]): { ok: boolean; out: string; error: string } => {
    const run = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

    return { ok: run.status === 0, out: (run.stdout ?? '').trim(), error: (run.stderr ?? '').trim() }
  }

  const commit = git(['rev-parse', '--verify', '--quiet', `${before}^{commit}`])

  if (!commit.ok || !commit.out) {
    return { error: `${before} is neither a roll file (.json) nor a commit this repository has` }
  }

  const top = git(['rev-parse', '--show-toplevel']).out
  const prefix = git(['rev-parse', '--show-prefix']).out
  // under the commit, so a second diff against it reads what the first wrote, and a ref that moved reads its new commit
  const at = path.join(root, 'tmp', `roll-at-${commit.out.slice(0, 12)}`)
  const rolled = path.join(at, prefix)

  if (!existsSync(rolled)) {
    mkdirSync(at, { recursive: true })

    const archive = spawnSync('git', ['-C', top, 'archive', '--format=tar', commit.out, ...(prefix ? [prefix] : [])], { maxBuffer: 1024 * 1024 * 1024 })

    if (archive.status !== 0) {
      return { error: `git archive could not read ${before}: ${String(archive.stderr ?? '').trim()}` }
    }

    const tar = spawnSync('tar', ['-x', '-C', at], { input: archive.stdout })

    if (tar.status !== 0) {
      return { error: `the tree of ${before} could not be unpacked: ${String(tar.stderr ?? '').trim()}` }
    }
  }

  // the dependencies the project has now: `link/` is not in a commit, and a roll of the old tree needs them to resolve
  const link = path.join(root, 'link')

  if (existsSync(link) && !existsSync(path.join(rolled, 'link'))) {
    symlinkSync(link, path.join(rolled, 'link'))
  }

  const old = roll(rolled)

  addReach(old, rolled)

  return { roll: old }
}

// the entries of one kind by host and name, several of one name (an overload, a method on two forms) read as one
function byName(entries: RollEntry[]): Map<string, RollEntry[]> {
  const out = new Map<string, RollEntry[]>()

  for (const entry of entries) {
    const key = `${entry.host} ${entry.name}`

    out.set(key, [...(out.get(key) ?? []), entry])
  }

  return out
}

function union(entries: RollEntry[], field: 'reach' | 'halt'): string[] {
  return [...new Set(entries.flatMap(entry => (Array.isArray(entry[field]) ? (entry[field] as string[]) : [])))].sort()
}

function delta(before: string[], after: string[]): { added: string[]; removed: string[] } {
  return { added: after.filter(one => !before.includes(one)), removed: before.filter(one => !after.includes(one)) }
}

export function diffRolls(beforeName: string, before: Roll, after: Roll, host: string): RollDiff {
  const own = (entries: RollEntry[]): RollEntry[] => entries.filter(entry => entry.host === host)
  // the reach is compared only when the earlier roll recorded it: a roll written before tasks carried it would read as
  // every task gaining everything
  const reach = own(before.task).some(task => Array.isArray(task.reach)) || own(before.task).length === 0
  const was = byName(own(before.task))
  const now = byName(own(after.task))
  const tasks: RollDiff['tasks'] = { added: [], removed: [], changed: [] }

  for (const [key, entries] of now) {
    const old = was.get(key)
    const name = entries[0]!.name
    const site = entries[0]!.site

    if (!old) {
      tasks.added.push({ name, site, reach: union(entries, 'reach'), halt: union(entries, 'halt') })
      continue
    }

    const reachDelta = reach ? delta(union(old, 'reach'), union(entries, 'reach')) : { added: [], removed: [] }
    const haltDelta = delta(union(old, 'halt'), union(entries, 'halt'))
    const asyncBefore = old.some(entry => entry.async === true)
    const asyncAfter = entries.some(entry => entry.async === true)

    if (reachDelta.added.length || reachDelta.removed.length || haltDelta.added.length || haltDelta.removed.length || asyncBefore !== asyncAfter) {
      tasks.changed.push({
        name,
        site,
        reach: reachDelta,
        halt: haltDelta,
        ...(asyncBefore !== asyncAfter ? { async: { before: asyncBefore, after: asyncAfter } } : {}),
      })
    }
  }

  for (const [key, entries] of was) {
    if (!now.has(key)) {
      tasks.removed.push({ name: entries[0]!.name, site: entries[0]!.site })
    }
  }

  const exceptionNames = (entries: RollEntry[]): string[] => [...new Set(entries.map(entry => `${entry.host}/${entry.name}`))].sort()
  const routesBefore = byName(own(before.dock))
  const routesAfter = byName(own(after.dock))

  // every other deck, counted: what entered or left the build, and how many of its tasks changed what they raise
  const decks: RollDiff['decks'] = []
  const hosts = new Set([...before.task, ...after.task, ...before.exception, ...after.exception].map(entry => entry.host))

  for (const other of [...hosts].filter(one => one !== host).sort()) {
    const of = (entries: RollEntry[]): RollEntry[] => entries.filter(entry => entry.host === other)
    const tasksBefore = byName(of(before.task))
    const tasksAfter = byName(of(after.task))
    const changed = [...tasksAfter].filter(([key, entries]) => {
      const old = tasksBefore.get(key)
      const halt = old ? delta(union(old, 'halt'), union(entries, 'halt')) : undefined

      return halt !== undefined && (halt.added.length > 0 || halt.removed.length > 0)
    }).length
    const exceptions = delta(exceptionNames(of(before.exception)), exceptionNames(of(after.exception)))
    const counts = {
      host: other,
      tasks: {
        added: [...tasksAfter.keys()].filter(key => !tasksBefore.has(key)).length,
        removed: [...tasksBefore.keys()].filter(key => !tasksAfter.has(key)).length,
        changed,
      },
      exceptions: { added: exceptions.added.length, removed: exceptions.removed.length },
    }

    if (counts.tasks.added || counts.tasks.removed || counts.tasks.changed || counts.exceptions.added || counts.exceptions.removed) {
      decks.push(counts)
    }
  }

  return {
    before: beforeName,
    host,
    tasks,
    exceptions: delta(exceptionNames(own(before.exception)), exceptionNames(own(after.exception))),
    routes: {
      added: [...routesAfter.keys()].filter(key => !routesBefore.has(key)).map(key => routesAfter.get(key)![0]!.name),
      removed: [...routesBefore.keys()].filter(key => !routesAfter.has(key)).map(key => routesBefore.get(key)![0]!.name),
      changed: [...routesAfter]
        .filter(([key]) => routesBefore.has(key))
        .map(([key, entries]) => ({ name: entries[0]!.name, halt: delta(union(routesBefore.get(key)!, 'halt'), union(entries, 'halt')) }))
        .filter(route => route.halt.added.length || route.halt.removed.length),
    },
    decks,
    reach,
  }
}

// how many tasks gained a native module, which is what `--strict` fails on
export function reachGains(diff: RollDiff): number {
  return diff.tasks.added.filter(task => task.reach.length).length + diff.tasks.changed.filter(task => task.reach.added.length).length
}
