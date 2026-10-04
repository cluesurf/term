// `term roll [kind]` -- the roll of this project: every deck in the build, every exception with who can raise it,
// every public task with what it raises, every route, every tell. Recomputed from source, so never stale. Prints as
// a tree; `--json` prints the same shape `term make` writes to host/roll.json. See note/term/hive/08-cli.md.

import { readFileSync } from 'fs'
import path from 'path'
import { compile } from '@term/make/code/compile/compile'
import type { Roll } from '@term/make/code/compile/roll'
import { projectDeckOf } from '@term/call/code/deck-of'
import { projectRoleOf, projectLeanOf } from '@term/call/code/role-of'
import { mergeRolls, showRoll } from '@term/make/code/compile/roll'
import { findTreeFiles, projectResolver } from '@term/call/code/make'
import type { BuildProblem } from '@term/call/code/make'
import { projectCache } from '@term/call/code/cache-store'
import { readable } from '@term/call/code/test-preprocess'
import { closeRun, count, field, openRun, printData, report, reportProblems } from '@term/call/code/output'

export const ROLL_KINDS = ['deck', 'exception', 'task', 'dock', 'tell', 'kind', 'supervision']

// the roll of every entry under `root` that is the project's own (not a linked dependency), merged. It prints
// nothing: a file that does not compile is in `failed`, and its diagnostics in `problems` for the caller to report
// (`term roll` draws them; `term make` has reported the same ones from its own build already)
export function projectRoll(root: string): {
  roll: Roll
  failed: string[]
  problems: BuildProblem[]
} {
  const link = path.join(root, 'link') + path.sep
  // the same walk `term make` does for node: other platforms' native trees are not compiled here either
  const files = findTreeFiles(root, [], 'node').filter(f => !f.startsWith(link))
  const resolve = projectResolver(root)
  const cache = projectCache(root)
  const deckOf = projectDeckOf()
  // the role and lean readers, the same ones `term make` compiles with. The roll is a SECOND compile of every
  // file, so without them a lean grammar that just built clean is read long-form here and every property head
  // in it is reported as an unknown name, under the "Compiled N files" line (lean-0035, 2026-09-12).
  const roleOf = projectRoleOf(root)
  const leanOf = projectLeanOf(root)
  const rolls: Roll[] = []
  const failed: string[] = []
  const problems: BuildProblem[] = []

  for (const file of files) {
    const unit = readable(readFileSync(file, 'utf8'))
    const result = compile(
      { file, text: unit.text },
      { resolve, cache, roll: true, deckOf, roleOf, leanOf },
    )

    if (!result.ok) {
      failed.push(path.relative(root, file))

      for (const diagnostic of result.diagnostics) {
        problems.push(diagnostic.file === file ? unit.place(diagnostic) : { diagnostic, text: undefined })
      }

      continue
    }

    if (result.roll) {
      rolls.push(relativize(result.roll, root))
    }
  }

  return { roll: mergeRolls(rolls), failed, problems }
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
}): Promise<void> {
  openRun({ verb: 'roll', root: input.root, facts: input.kind ? [input.kind] : [] })

  const { roll, failed, problems } = projectRoll(input.root)

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

  // the roll is the answer the user asked for: data on stdout, as a tree or as the JSON `term make` writes
  if (input.json) {
    printData(JSON.stringify(roll, null, 2) + '\n')
  } else {
    printData(`\n${showRoll(roll, input.kind, { path: input.path })}\n\n`)
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

  closeRun({
    verdict: failed.length ? 'Rolled, with files missing' : 'Rolled',
    counts: [
      count(roll.exception.length, 'exceptions', 'exception'),
      count(roll.task.length, 'tasks', 'task'),
      count(roll.dock.length, 'routes', 'route'),
    ],
  })
}
