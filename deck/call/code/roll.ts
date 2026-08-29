// `term roll [kind]` -- the roll of this project: every deck in the build, every exception with who can raise it,
// every public task with what it raises, every route, every tell. Recomputed from source, so never stale. Prints as
// a tree; `--json` prints the same shape `term make` writes to host/roll.json. See note/term/hive/08-cli.md.

import { readFileSync } from 'fs'
import path from 'path'
import { compile } from '@term/make/code/compile/compile'
import type { Roll } from '@term/make/code/compile/roll'
import { projectDeckOf } from '@term/call/code/deck-of'
import { renderDiagnostic } from '@term/call/code/report'
import { mergeRolls, showRoll } from '@term/make/code/compile/roll'
import { findTreeFiles, projectResolver } from '@term/call/code/make'
import { projectCache } from '@term/call/code/cache-store'
import { preprocessTests } from '@term/call/code/test-preprocess'
import { logFail, logStep, fade } from '@term/make/code/tint'

export const ROLL_KINDS = ['deck', 'exception', 'task', 'dock', 'tell', 'kind']

// the roll of every entry under `root` that is the project's own (not a linked dependency), merged
export function projectRoll(root: string): {
  roll: Roll
  failed: string[]
} {
  const link = path.join(root, 'link') + path.sep
  // the same walk `term make` does for node: other platforms' native trees are not compiled here either
  const files = findTreeFiles(root, [], 'node').filter(f => !f.startsWith(link))
  const resolve = projectResolver(root)
  const cache = projectCache(root)
  const deckOf = projectDeckOf()
  const rolls: Roll[] = []
  const failed: string[] = []

  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const text = /^\s*test /m.test(source)
      ? preprocessTests(source).text
      : source
    const result = compile(
      { file, text },
      { resolve, cache, roll: true, deckOf },
    )

    if (!result.ok) {
      failed.push(path.relative(root, file))

      for (const diagnostic of result.diagnostics) {
        console.error(
          renderDiagnostic(
            diagnostic,
            diagnostic.file === file ? text : undefined,
          ),
        )
      }

      continue
    }

    if (result.roll) {
      rolls.push(relativize(result.roll, root))
    }
  }

  return { roll: mergeRolls(rolls), failed }
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
  if (!input.json) {
    logStep('Rolling...')
  }

  const { roll, failed } = projectRoll(input.root)

  // a kind is built in, or declared by a deck of this build (`roll <name>`)
  if (input.kind && !ROLL_KINDS.includes(input.kind) && !roll.kind.some(k => k.name === input.kind)) {
    const declared = roll.kind.map(k => k.name)
    logFail(`Unknown kind "${input.kind}". One of: ${[...ROLL_KINDS, ...declared].join(', ')}`)
    process.exit(1)
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

  if (input.json) {
    process.stdout.write(JSON.stringify(roll, null, 2) + '\n')
  } else {
    console.log('')
    console.log(showRoll(roll, input.kind, { path: input.path }))
    console.log('')
  }

  if (failed.length) {
    console.error(
      fade(`  ${failed.length} file(s) did not compile and are not on the roll: ${failed.join(', ')}`),
    )
  }
}
