// Rewrite `load @scope/name/code/<path>` to the short form `load @scope/name/<path>`, now that a package path
// resolves inside the package's code root first (note/project/term/manifest/manifest-mark-and-code-root.md).
//
// EVERY REWRITE IS PROVEN, never assumed. For each path the long and the short spelling are both resolved by the
// build's own resolver (`projectResolver` for the file's package, the one `term make`, the language server and
// `term look` ask), from that file, and the rewrite is made only when both name the SAME file. A `{platform}` path is
// compared under EVERY native env, since each env fills the slot differently. Skipped, and listed with the reason:
//
//   - the long path resolves to nothing (nothing to preserve)
//   - the short path resolves to another file, or to nothing (the rewrite would change the target)
//   - the short path also names a file in the PACKAGE root, which the code root shadows. The target is the same,
//     but `term lint` would then warn `ambiguous-load`; the long form says what it means, so it stays
//   - the path is not written plainly on its line (an escaped or split spelling)
//
// Resolution happens AT WRITE TIME, file by file: other work rewrites `.tree` files here at the same time, so each
// file is read, its paths resolved, and the file read again right before the write. If it changed in between, the
// work is redone against the new text.
//
// Fixtures whose text IS the expectation are not touched: a parser fixture (`---` between input and expected
// parse) and the parser and formatter fixture directories.
//
// Reports by default; writes only with --commit.
//
//   pnpm term:short-loads             what would change, and every skip with its reason
//   pnpm term:short-loads --commit    rewrite
//   pnpm term:short-loads --only <dir>
//   pnpm term:short-loads --guides    the same for every package path note/project/term/guides/draft writes

import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { parse, renderHead } from '@term/make/code/parser/tree'
import type { Node } from '@term/make/code/parser/tree'
import type { GroupNode } from '@term/make/code/parser/narrow'
import { spanOfNode } from '@term/make/code/compile/mill-run'
import { projectResolver } from '@term/call/code/make'
import { NATIVE_ENVS } from '@term/make/code/compile/native'
import type { NativeEnv } from '@term/make/code/compile/native'
import type { Resolver } from '@term/make/code/compile/load'
import { TERM_ROOT, parentPaths, parentRoot } from './root'

const ROOT = TERM_ROOT
const commit = process.argv.includes('--commit')
const onlyAt = process.argv.indexOf('--only')
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : undefined

// the trees that hold Term packages
const TOPS = ['.', ...parentPaths('deck/zone'), ...parentPaths('mesh/deck'), ...parentPaths('mesh/site')]

const SKIP_DIRS = new Set(['node_modules', '.git', '.base', 'tmp', 'link', 'tail'])

// fixture directories whose files are compared byte for byte against an expected output
const FIXTURE_DIRS = ['test/parser/', 'test/format/', 'test/tree/']

function walk(dir: string, out: string[]): void {
  let entries: string[]

  try {
    entries = readdirSync(dir)
  } catch {
    return
  }

  for (const entry of entries) {
    const full = join(dir, entry)

    if (SKIP_DIRS.has(entry) || entry.endsWith('-cache') || entry.endsWith('.worktree')) {
      continue
    }

    let isDir = false

    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }

    if (isDir) {
      // `host/` is build output, except a package of that name (it has a manifest)
      if (entry === 'host' && !statSync(join(full, 'deck.tree'), { throwIfNoEntry: false })) {
        continue
      }

      walk(full, out)
    } else if (entry.endsWith('.tree')) {
      out.push(full)
    }
  }
}

// the package a file builds in: the nearest directory above it with a deck.tree, as `term make` finds it
function packageOf(file: string): string | undefined {
  let dir = dirname(file)

  for (;;) {
    if (statSync(join(dir, 'deck.tree'), { throwIfNoEntry: false })) {
      return dir
    }

    const up = dirname(dir)

    if (up === dir) {
      return undefined
    }

    dir = up
  }
}

const resolvers = new Map<string, Resolver>()

function resolverFor(root: string, env: NativeEnv): Resolver {
  const key = `${root}\0${env}`
  let found = resolvers.get(key)

  if (!found) {
    found = projectResolver(root, env)
    resolvers.set(key, found)
  }

  return found
}

const real = (file: string): string => {
  try {
    return realpathSync(file)
  } catch {
    return file
  }
}

// the short spelling of a long one, or undefined when the path does not name a code root folder
function shortOf(path: string): string | undefined {
  const scoped = /^(@[^/]+\/[^/]+)\/code(?:\/(.*))?$/.exec(path)

  if (scoped) {
    return scoped[2] === undefined ? scoped[1]! : `${scoped[1]!}/${scoped[2]}`
  }

  const local = /^@\/code\/(.+)$/.exec(path)

  return local ? `@/${local[1]!}` : undefined
}

type Edit = { line: number; column: number; from: string; to: string }
type Skip = { path: string; line: number; reason: string }

// every load path a file names (any depth, so a nested load counts), with where it is written
function loadsOf(text: string, file: string): { path: string; line: number; column: number }[] {
  const parsed = parse({ file, text })

  if (!parsed.ok) {
    return []
  }

  const out: { path: string; line: number; column: number }[] = []

  const headOf = (node: Node | undefined): string | undefined => {
    const first = node?.kind === 'group' ? node.nodes[0] : undefined

    return first?.kind === 'name' ? renderHead(first) : undefined
  }

  const visit = (group: GroupNode): void => {
    const head = headOf(group)

    if (head === 'load' || head === 'bear') {
      const target = group.nodes[1]
      const name = target?.kind === 'group' ? target.nodes[0] : undefined
      const path = headOf(target)
      const at = name ? spanOfNode(name) : undefined

      if (path && at && path.startsWith('@')) {
        out.push({ path, line: at.start.line, column: at.start.column })
      }
    }

    for (const child of group.nodes.slice(1)) {
      if (child.kind === 'group') {
        visit(child)
      }
    }
  }

  for (const group of parsed.tree.nodes) {
    visit(group)
  }

  return out
}

function plan(text: string, file: string, root: string): { edits: Edit[]; skips: Skip[] } {
  const edits: Edit[] = []
  const skips: Skip[] = []
  const lines = text.split('\n')

  for (const load of loadsOf(text, file)) {
    const short = shortOf(load.path)

    if (!short) {
      continue
    }

    const row = lines[load.line] ?? ''

    if (row.slice(load.column, load.column + load.path.length) !== load.path) {
      skips.push({ path: load.path, line: load.line, reason: 'not written plainly on its line' })
      continue
    }

    const envs: readonly NativeEnv[] = load.path.includes('{platform}') ? NATIVE_ENVS : ['node']
    let verdict: string | undefined

    for (const env of envs) {
      const resolve = resolverFor(root, env)
      const long = resolve(load.path, file)
      const brief = resolve(short, file)

      if (!long) {
        // under one env a slot may name nothing in either spelling; that is the same answer
        if (brief) {
          verdict = `under ${env} the long path names nothing and the short one names ${relative(ROOT, brief.file)}`
          break
        }

        if (envs.length === 1) {
          verdict = 'the long path resolves to nothing'
          break
        }

        continue
      }

      if (!brief || real(brief.file) !== real(long.file)) {
        verdict = `under ${env} the short path names ${brief ? relative(ROOT, brief.file) : 'nothing'}, not ${relative(ROOT, long.file)}`
        break
      }

      if (brief.shadowed) {
        verdict = `the short path also names ${relative(ROOT, brief.shadowed)} in the package root (ambiguous-load)`
        break
      }
    }

    if (verdict) {
      skips.push({ path: load.path, line: load.line, reason: verdict })
      continue
    }

    edits.push({ line: load.line, column: load.column, from: load.path, to: short })
  }

  return { edits, skips }
}

function apply(text: string, edits: Edit[]): string {
  const lines = text.split('\n')

  for (const edit of [...edits].sort((a, b) => b.line - a.line || b.column - a.column)) {
    const row = lines[edit.line]!
    lines[edit.line] = row.slice(0, edit.column) + edit.to + row.slice(edit.column + edit.from.length)
  }

  return lines.join('\n')
}

// ---- the guides: `--guides` rewrites the package paths a guide WRITES (samples and prose) ----
//
// A guide's samples are compiled by tmp/lean-guide/page.sh in a scratch project of their own, where every `@term/*`
// path resolves by name (the stdlib and its sibling packages), never through the scratch project. So each path is
// resolved from a file inside the Term package, which reaches the same packages the same way, and rewritten only
// when the long and short spellings name the same file and the short one is not ambiguous. A path that names no
// module (a folder mentioned in prose) resolves to nothing and is left as written.

const GUIDES = (): string => join(parentRoot(), 'note/project/term/guides/draft')
const TERM = TERM_ROOT

function guideFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)

    if (statSync(full).isDirectory()) {
      guideFiles(full, out)
    } else if (entry.endsWith('.md')) {
      out.push(full)
    }
  }
}

function rewriteGuides(): void {
  const files: string[] = []
  guideFiles(GUIDES(), files)

  const from = join(TERM, 'tmp', 'guide-sample.tree')
  const verdicts = new Map<string, string | undefined>()
  let paths = 0
  let changedFiles = 0
  const kept: string[] = []

  const verdictOf = (long: string, short: string): string | undefined => {
    if (verdicts.has(long)) {
      return verdicts.get(long)
    }

    let verdict: string | undefined
    const envs: readonly NativeEnv[] = long.includes('{platform}') ? NATIVE_ENVS : ['node']

    for (const env of envs) {
      const resolve = resolverFor(TERM, env)
      const a = resolve(long, from)
      const b = resolve(short, from)

      if (!a && !b && envs.length > 1) {
        continue
      }

      if (!a) {
        verdict = 'names no module (a folder, or nothing)'
        break
      }

      if (!b || real(a.file) !== real(b.file)) {
        verdict = `under ${env} the short path names ${b ? relative(ROOT, b.file) : 'nothing'}`
        break
      }

      if (b.shadowed) {
        verdict = `ambiguous: also ${relative(ROOT, b.shadowed)}`
        break
      }
    }

    verdicts.set(long, verdict)

    return verdict
  }

  for (const file of files.sort()) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const text = readFileSync(file, 'utf8')
      let count = 0

      const next = text.replace(/@term\/([a-z][a-z0-9-]*)\/code((?:\/[A-Za-z0-9_{}-]+)*)(?![A-Za-z0-9_{}./-])/g, (long, pkg: string, rest: string) => {
        const short = `@term/${pkg}${rest}`
        const verdict = verdictOf(long, short)

        if (verdict) {
          if (attempt === 0) {
            kept.push(`${relative(ROOT, file)} ${long}: ${verdict}`)
          }

          return long
        }

        count++

        return short
      })

      if (count === 0) {
        break
      }

      if (!commit) {
        paths += count
        changedFiles++
        break
      }

      if (readFileSync(file, 'utf8') !== text) {
        continue
      }

      writeFileSync(file, next)
      paths += count
      changedFiles++
      break
    }
  }

  for (const line of kept) {
    console.log(`  kept ${line}`)
  }

  console.log(
    `\nshort-loads --guides: ${files.length} guides, ${paths} paths ${commit ? 'rewritten' : 'to rewrite'} in ${changedFiles} files, ${kept.length} kept as written`,
  )
}

if (process.argv.includes('--guides')) {
  rewriteGuides()
  process.exit(0)
}

const files: string[] = []

for (const top of TOPS) {
  walk(join(ROOT, top), files)
}

let rewrittenFiles = 0
let rewrittenPaths = 0
let candidates = 0
const skips: string[] = []
const fixtures: string[] = []
const loose: string[] = []

for (const file of files.sort()) {
  const where = relative(ROOT, file)

  if (only && !where.startsWith(only)) {
    continue
  }

  if (FIXTURE_DIRS.some(dir => where.startsWith(dir))) {
    continue
  }

  const root = packageOf(file)

  for (let attempt = 0; attempt < 3; attempt++) {
    const text = readFileSync(file, 'utf8')

    if (!text.includes('/code')) {
      break
    }

    if (/^---$/m.test(text)) {
      fixtures.push(where)
      break
    }

    if (!root) {
      loose.push(where)
      break
    }

    const { edits, skips: skipped } = plan(text, file, root)

    if (attempt === 0) {
      candidates += edits.length + skipped.length

      for (const skip of skipped) {
        skips.push(`${where}:${skip.line + 1} ${skip.path}: ${skip.reason}`)
      }
    }

    if (edits.length === 0) {
      break
    }

    if (!commit) {
      rewrittenFiles++
      rewrittenPaths += edits.length
      break
    }

    // read again right before the write: anything that changed the file since its paths were resolved means the
    // resolution is redone against what is there now
    if (readFileSync(file, 'utf8') !== text) {
      continue
    }

    writeFileSync(file, apply(text, edits))
    rewrittenFiles++
    rewrittenPaths += edits.length
    break
  }
}

for (const skip of skips) {
  console.log(`  skipped ${skip}`)
}

for (const fixture of fixtures) {
  console.log(`  untouched fixture ${fixture}`)
}

for (const file of loose) {
  console.log(`  no package (no deck.tree above it) ${file}`)
}

console.log(
  `\nshort-loads: ${files.length} .tree files, ${candidates} long package paths, ${rewrittenPaths} ${commit ? 'rewritten' : 'to rewrite'} in ${rewrittenFiles} files, ${skips.length} skipped`,
)

if (!commit && rewrittenPaths > 0) {
  console.log('short-loads: pass --commit to write')
}
