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
import * as port from '@term/call/code/roll-delta'

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

// a roll entry as the port reads it: a field that is not a list reads as none (`reach`) or empty (`halt`), and only a
// literal `true` is async, as the comparison this replaced read them
function entryOf(entry: RollEntry): port.RollEntry {
  return {
    host: entry.host,
    name: entry.name,
    site: entry.site,
    reach: Array.isArray(entry.reach) ? { form: 'some', value: entry.reach as string[] } : { form: 'none' },
    halt: Array.isArray(entry.halt) ? (entry.halt as string[]) : [],
    async: entry.async === true,
  }
}

function listsOf(roll: Roll): port.RollLists {
  return { task: roll.task.map(entryOf), exception: roll.exception.map(entryOf), dock: roll.dock.map(entryOf) }
}

// the comparison itself is Term (call/code/roll-delta.tree), and its result is this shape field for field
export function diffRolls(beforeName: string, before: Roll, after: Roll, host: string): RollDiff {
  return port.diffRolls(beforeName, listsOf(before), listsOf(after), host)
}

// how many tasks gained a native module, which is what `--strict` fails on
export function reachGains(diff: RollDiff): number {
  return port.reachGains(diff)
}
