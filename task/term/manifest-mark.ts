// Rewrite every Term manifest in the repository to the current spelling (note/project/term/manifest/manifest-mark-and-code-root.md):
//
//   code <1.4.2>                 ->  mark <1.4.2>                 the version
//   link @x/y, code <0.0.x>      ->  link @x/y, mark <0.0.x>      a dependency's versions
//   bear ./code                  ->  (removed: the default code root)
//   bear ./src                   ->  code ./src
//
// The edits are the ones `term lint --fix` applies (`manifest-code-version`, `manifest-bear`): both call
// `manifestSpellings` in deck/deck/code/manifest.ts, so the task and the lint rule cannot disagree. Each edit touches
// one word or one line, so comments, blank lines and field order are kept.
//
// A MANIFEST is a `deck.tree` whose top-level `deck` statement names a package (manifestName). A stdlib code module
// that happens to be called deck.tree is not one and is never touched. A PARSER FIXTURE (a `---` line between an
// input and its expected parse) is not one either, even though it opens with `deck`: rewriting it would change the
// parser's test, so it is skipped and listed.
//
// Each file is read again IMMEDIATELY before it is written, and written only if it is still the text the edits were
// computed from, because other work rewrites `.tree` files in this repository at the same time.
//
// Reports by default; writes only with --commit.
//
//   pnpm term:manifest-mark            what would change
//   pnpm term:manifest-mark --commit   rewrite

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { manifestName } from '../../deck/call/code/manifest-name'
import { rewriteManifestSpellings } from '../../deck/deck/code/package/manifest'
import { TERM_ROOT } from './root'

const ROOT = TERM_ROOT
const commit = process.argv.includes('--commit')

// generated output, dependencies, caches, scratch, and other checkouts of this repository
const SKIP_DIRS = new Set(['node_modules', '.git', '.base', 'tmp', 'link', 'land', 'mesh.worktree', 'talk.worktree', 'vibe.worktree'])

function walk(dir: string, out: string[]): void {
  let entries: string[]

  try {
    entries = readdirSync(dir)
  } catch {
    return
  }

  for (const entry of entries) {
    const full = join(dir, entry)

    if (SKIP_DIRS.has(entry) || entry.endsWith('-cache')) {
      continue
    }

    let isDir = false

    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }

    if (isDir) {
      // `host/` is build output, EXCEPT the @term/host package, which is a directory with its own manifest
      if (entry === 'host' && !statSync(join(full, 'deck.tree'), { throwIfNoEntry: false })) {
        continue
      }

      walk(full, out)
    } else if (entry === 'deck.tree') {
      out.push(full)
    }
  }
}

const files: string[] = []

for (const top of ['deck', 'mesh', 'task', 'note', 'base', 'lock']) {
  walk(join(ROOT, top), files)
}

let rewritten = 0
let edits = 0
let clean = 0
const skipped: string[] = []
const changed: string[] = []

for (const file of files.sort()) {
  const where = relative(ROOT, file)
  const text = readFileSync(file, 'utf8')

  if (manifestName(text, file) === undefined) {
    skipped.push(`${where}: not a manifest (no top-level \`deck\` statement naming a package)`)
    continue
  }

  if (/^---$/m.test(text)) {
    skipped.push(`${where}: a parser fixture (input, \`---\`, expected parse), not a manifest`)
    continue
  }

  const fixed = rewriteManifestSpellings({ text, file })

  if (fixed.changes.length === 0) {
    clean++
    continue
  }

  edits += fixed.changes.length
  rewritten++
  changed.push(`${where}: ${fixed.changes.map(c => `${c.rule}@${c.line + 1}`).join(', ')}`)

  if (commit) {
    // read again right before writing: write only if nothing else changed the file since it was read
    if (readFileSync(file, 'utf8') !== text) {
      skipped.push(`${where}: changed while this ran, not written; run again`)
      rewritten--
      continue
    }

    writeFileSync(file, fixed.text)
  }
}

for (const line of changed) {
  console.log(`  ${commit ? 'wrote' : 'would rewrite'} ${line}`)
}

for (const line of skipped) {
  console.log(`  skipped ${line}`)
}

console.log(
  `\nmanifest-mark: ${files.length} deck.tree files, ${rewritten} ${commit ? 'rewritten' : 'to rewrite'} (${edits} edits), ${clean} already current, ${skipped.length} skipped`,
)

if (!commit && rewritten > 0) {
  console.log('manifest-mark: pass --commit to write')
}
