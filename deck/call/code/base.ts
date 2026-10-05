/**
 * `term base`: the read verbs.
 *
 * The Git-not-GitHub split in `note/library/base/readme.md` promises the protocol works fully
 * offline with no server. Until now that promise was true only through a TypeScript import,
 * so nobody could use base without writing code, the flagship dataset could not be driven by
 * hand, and the authoring loop had never been experienced by a person.
 *
 * A subcommand of `term` rather than a binary of its own, decided in
 * `note/library/base/12-naming.md`: it inherits Term's install path, the overload the naming
 * doc worried about is always qualified by the verb in front of it, and it is the reversible
 * choice, because a standalone binary can be added later without breaking anyone.
 *
 * READ VERBS ONLY, on purpose. They cannot damage a repository, and they are how a person
 * learns the record model before being trusted to write to it. Every one is a thin surface
 * over a tested library function rather than new machinery, so a bug here is a printing bug.
 *
 * The store is on disk under `.base/` so a repository is a directory a person can look at,
 * copy, and delete, the way a `.git` directory is.
 */

import fs from 'node:fs'
import path from 'node:path'

import { Repository } from '@cluesurf/save/repo/repo'
import { isMark, mintMark } from '@cluesurf/save/base/mark'
import { MemoryChunkStore } from '@cluesurf/save/store/chunk-store'
import { MemoryRefStore } from '@cluesurf/save/store/ref-store'
import { commitChanges } from '@cluesurf/save/project/feed'
import { canonicalizeRecord } from '@cluesurf/save/canon/canonicalize'
import { FORMAT_REF } from '@cluesurf/save/canon/format'
import { walkTree } from '@cluesurf/save/api/export'
import { rowsFor } from '@cluesurf/save/project/projector'
import type { Mapping } from '@cluesurf/save/project/mapping'
import type { TableForm } from '@cluesurf/save/project/table'
import { MixedField, inferProjection } from '@cluesurf/save/project/infer'
import { Projector } from '@cluesurf/save/project/projector'
import { openPostgres, postgresEngine } from './base-engine'
import { parseTree } from '@cluesurf/save/tree/parse'
import { formatTree } from '@cluesurf/save/tree/format'
import { datasetOf, type Dataset } from '@cluesurf/save/diff/change'
import type { RecordNode } from '@cluesurf/save/base/type'
import { closeRun, count, field, isRunOpen, location, openRun, printData, report } from '@term/call/code/output'
import type { ItemField } from '@term/call/code/work/item/event'

// THE OUTPUT (note/term/output/readme.md). Each verb opens a run with its own verb and closes it with a verdict on
// stderr, and what the person asked to SEE (a log, a diff, a record, a listing, a commit hash) is data on stdout,
// through `printData`, so `term base log > log.txt` holds the log and nothing else.

// a refusal that ends the command at once: a ✗ item, the closing item, and the exit code it gives (section 18). The
// helpers below hand back a value (`need`, `resolve`, `working`), so the process stops here rather than returning
// (`failure`: <usage> for a bad invocation, exit 2, rather than the default exit 1)
export function refuse(subject: string, extra: { message?: string[]; fields?: ItemField[]; next?: string; verdict?: string; failure?: string } = {}): never {
  if (!isRunOpen()) {
    openRun({ verb: 'base', root: process.cwd() })
  }

  report({ glyph: 'failed', kind: 'problem', subject, message: extra.message, fields: extra.fields })
  process.exit(closeRun({ verdict: extra.verdict ?? 'Nothing was done', next: extra.next, failure: extra.failure }))
}

// data lines on stdout, one per line, as they always were
function printLines(lines: string[]): void {
  if (lines.length) {
    printData(`${lines.join('\n')}\n`)
  }
}

// Where a repository keeps itself, beside the working files, the way `.git` does.
const HOME = '.base'

const CHUNKS = 'chunk.json'
const REFS = 'ref.json'

/**
 * The repository's own identity, one uuid on one line.
 *
 * A projection's bookkeeping is keyed by repository and that column is a UUID, so a
 * repository needs one before it can be projected anywhere.
 *
 * Persisted rather than derived from the directory name, which was the obvious first idea
 * and is wrong: renaming or moving the directory would change the identity, and the
 * projection's watermark would be orphaned. Nothing would report it, because a watermark
 * for a repository nobody asks about looks exactly like a repository that has never been
 * projected, and the next run would rebuild from empty.
 */
const NAME = 'repository'

/**
 * Load a repository from disk.
 *
 * The stores are the in-memory ones with their contents read from two JSON files, which is
 * enough for a local repository a person drives by hand and is deliberately not the
 * production substrate: the durable stores live in mesh and speak to Postgres and R2. Keeping
 * this simple means the CLI cannot be the reason a commit is lost.
 */
function open(root: string):
  | { repo: Repository; refs: MemoryRefStore; save: () => void }
  | undefined {
  const home = path.join(root, HOME)

  if (!fs.existsSync(home)) {
    return undefined
  }

  const chunks = new MemoryChunkStore()
  const refs = new MemoryRefStore()

  const chunkFile = path.join(home, CHUNKS)
  const refFile = path.join(home, REFS)

  if (fs.existsSync(chunkFile)) {
    const held = JSON.parse(fs.readFileSync(chunkFile, 'utf8')) as Record<
      string,
      string
    >

    // put by BYTES rather than by stored key, so the store re-derives every address and a
    // hand-edited or corrupted file cannot smuggle content in under the wrong hash
    for (const bytes of Object.values(held)) {
      chunks.put(bytes)
    }
  }

  if (fs.existsSync(refFile)) {
    const held = JSON.parse(fs.readFileSync(refFile, 'utf8')) as Record<
      string,
      string
    >

    for (const [name, at] of Object.entries(held)) {
      refs.compareAndSwap(name, undefined, at)
    }
  }

  const save = (): void => {
    const out: Record<string, string> = {}

    for (const hash of chunks.keys()) {
      out[hash] = chunks.get(hash)!
    }

    fs.writeFileSync(chunkFile, `${JSON.stringify(out, null, 0)}\n`)

    const named: Record<string, string> = {}

    for (const name of refs.list()) {
      named[name] = refs.get(name)!
    }

    fs.writeFileSync(refFile, `${JSON.stringify(named, null, 2)}\n`)
  }

  return { repo: new Repository(chunks, refs), refs, save }
}

/**
 * Expand a commit PREFIX to a full hash, the way git does.
 *
 * `log` prints a shortened hash because a full one is 71 characters and unreadable in a
 * column. Without this, every hash it prints is one the other verbs REFUSE, so the first
 * thing a person does by hand fails. Found by driving the verbs by hand, which is exactly
 * what that is for.
 *
 * Ambiguity is an error rather than a guess: picking one of two matching commits would be
 * silently showing the wrong history.
 */
function resolve(repo: Repository, given: string): string {
  if (repo.containsCommit(given)) {
    return given
  }

  const seen = new Set<string>()

  for (const branch of repo.branches()) {
    for (const { hash } of repo.log(branch)) {
      seen.add(hash)
    }
  }

  for (const name of repo.tags()) {
    const at = repo.tag(name)

    if (at !== undefined) {
      seen.add(at)
    }
  }

  const hit = [...seen].filter(hash => hash.startsWith(given))

  if (hit.length === 1) {
    return hit[0]!
  }

  if (hit.length > 1) {
    refuse(`${given} matches ${hit.length} commits`, { message: hit, next: 'give more of the hash' })
  }

  refuse(`No commit matches ${given}`, { next: 'term base log, for the hashes' })
}

export function need(root: string): {
  repo: Repository
  refs: MemoryRefStore
  save: () => void
} {
  const held = open(root)

  if (!held) {
    refuse('There is no repository here', { fields: [field('looked', path.join(root, HOME))], next: 'term base init, in the directory to track' })
  }

  return held
}

/** Every branch, and where it points. */
export function callBaseLog(input: { root: string; branch?: string }): void {
  openRun({ verb: 'log', root: input.root, facts: input.branch ? [input.branch] : [] })
  const { repo } = need(input.root)
  const branches = input.branch ? [input.branch] : repo.branches()

  if (!branches.length) {
    closeRun({ verdict: 'No branches yet', counts: [count(0, 'branches', 'branch')] })

    return
  }

  const lines: string[] = []
  let commits = 0

  for (const branch of branches) {
    const head = repo.head(branch)

    if (!head) {
      lines.push(`${branch}: no commits`)
      continue
    }

    lines.push(`${branch}`)

    for (const { hash, commit } of repo.log(branch)) {
      const when = new Date(commit.time).toISOString().slice(0, 19).replace('T', ' ')

      lines.push(`  ${hash.slice(0, 24)}  ${when}  ${commit.author}  ${commit.message}`)
      commits++
    }
  }

  printLines(lines)
  closeRun({ verdict: 'Log listed', counts: [count(branches.length, 'branches', 'branch'), count(commits, 'commits', 'commit')] })
}

/** What changed between two commits, as field-level changes. */
export function callBaseDiff(input: {
  root: string
  from?: string
  to: string
}): void {
  openRun({ verb: 'diff', root: input.root, facts: [input.from === undefined ? input.to : `${input.from} → ${input.to}`] })
  const { repo } = need(input.root)
  const to = resolve(repo, input.to)
  const from = input.from === undefined ? undefined : resolve(repo, input.from)
  const changes = commitChanges(repo, from, to)
  const lines: string[] = []

  for (const change of changes) {
    switch (change.type) {
      case 'record.add':
        lines.push(`+ ${change.mark}  ${change.value.type}`)
        break
      case 'record.remove':
        lines.push(`- ${change.mark}`)
        break
      case 'field.set':
        lines.push(`~ ${change.mark}  ${change.field}`)
        break
      case 'field.remove':
        lines.push(`~ ${change.mark}  ${change.field} removed`)
        break
      default:
        break
    }
  }

  printLines(lines)
  closeRun({ verdict: changes.length ? 'Changes listed' : 'No changes', counts: [count(changes.length, 'changes', 'change')] })
}

/** One record as of a commit, in canonical form. */
export function callBaseShow(input: {
  root: string
  commit: string
  mark: string
}): void {
  openRun({ verb: 'show', root: input.root, subject: input.mark, facts: [input.commit] })
  const { repo } = need(input.root)
  const at = resolve(repo, input.commit)
  const found = repo.recordAt(at, input.mark)

  if (!found) {
    refuse(`There is no record ${input.mark} at ${input.commit}`, { next: 'term base list <commit>, for the marks' })
  }

  // Both, and in this order. The readable half is what a person needs to learn the record
  // model, which is what a read verb is for. The canonical half is what is HASHED, and
  // showing only a pretty print would leave the one thing a person cannot otherwise check
  // invisible: whether the bytes about to be trusted are the bytes they think.
  const lines = [`mark  ${input.mark}`, `form  ${found.type}`]

  for (const [field, value] of [...found.fields].sort()) {
    const said =
      value.kind === 'text' || value.kind === 'decimal' || value.kind === 'date'
        ? String(value.value)
        : value.kind === 'integer' || value.kind === 'boolean'
          ? String(value.value)
          : value.kind === 'ref'
            ? `-> ${value.target}`
            : value.kind === 'null'
              ? '(null)'
              : `(${value.kind})`

    lines.push(`  ${field.padEnd(20)} ${said}`)
  }

  lines.push('', 'canonical bytes, which are what is hashed:', canonicalizeRecord(found))
  printLines(lines)
  closeRun({ verdict: 'Record shown', counts: [count(found.fields.size, 'fields', 'field')] })
}

/** Whether a repository is coherent, and what it holds. */
export function callBaseCheck(input: { root: string }): void {
  openRun({ verb: 'check', root: input.root })
  const { repo, refs } = need(input.root)
  const fsck = repo.fsck()

  // Read the ref DIRECTLY. `repo.head(name)` prepends `branch/`, so asking it for
  // `meta/format` looks for `branch/meta/format` and always answers undefined, which made
  // this print "(unversioned)" on a repository that was correctly versioned. The gate was
  // working; only the display was wrong.
  printLines([
    `format      ${refs.get(FORMAT_REF) ?? '(unversioned)'}`,
    `branches    ${repo.branches().join(', ') || '(none)'}`,
    `tags        ${repo.tags().join(', ') || '(none)'}`,
  ])

  if (fsck.missing.length) {
    // a list shows 10 entries and counts the rest (section 14)
    report({
      glyph: 'failed',
      kind: 'problem',
      subject: `${fsck.missing.length} chunk${fsck.missing.length === 1 ? ' is' : 's are'} missing`,
      message: [...fsck.missing.slice(0, 10), ...(fsck.missing.length > 10 ? [`… ${fsck.missing.length - 10} more`] : [])],
    })
    closeRun({ verdict: 'The repository is not coherent', counts: [count(fsck.missing.length, 'missing')] })

    return
  }

  closeRun({ verdict: 'No missing chunks', counts: [count(0, 'missing')] })
}

/** Every record at a commit, by mark and form. */
export function callBaseList(input: { root: string; commit: string }): void {
  openRun({ verb: 'list', root: input.root, facts: [input.commit] })
  const { repo } = need(input.root)
  const dataset = repo.checkout(resolve(repo, input.commit))

  printLines([...dataset.keys()].sort().map(mark => `${mark}  ${dataset.get(mark)!.type}`))
  closeRun({ verdict: 'Records listed', counts: [count(dataset.size, 'records', 'record')] })
}

/**
 * This repository's uuid, minting one if it predates the file.
 *
 * Minted on demand rather than refused, so a repository made before identities existed
 * starts working instead of needing a migration. It is written once and never changes.
 */
export function repositoryName(root: string): string {
  const at = path.join(root, HOME, NAME)

  if (fs.existsSync(at)) {
    const held = fs.readFileSync(at, 'utf8').trim()

    if (isMark(held)) {
      return held
    }
  }

  const minted = mintMark()

  fs.writeFileSync(at, `${minted}\n`)

  return minted
}

/** Create a repository here. The one write verb, because nothing else can run without it. */
export function callBaseInit(input: { root: string }): void {
  openRun({ verb: 'init', root: input.root })
  const home = path.join(input.root, HOME)

  if (fs.existsSync(home)) {
    refuse('This is already a repository', { fields: [field('found', `${HOME}/`)] })
  }

  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, CHUNKS), '{}\n')
  fs.writeFileSync(path.join(home, REFS), '{}\n')
  fs.writeFileSync(path.join(home, NAME), `${mintMark()}\n`)

  report({ glyph: 'added', kind: 'change', verb: 'add', subject: `${HOME}/` })
  closeRun({ verdict: 'An empty repository was made' })
}

// Where a person authors records: `.tree` files beside the repository, one per record. A
// directory of readable files rather than a database, so the working copy is something you
// can open, grep, and put in git alongside anything else.
const WORK = 'record'

/** Every `.tree` file under `record/`, parsed. */
function working(root: string): Dataset {
  const dir = path.join(root, WORK)

  if (!fs.existsSync(dir)) {
    return new Map()
  }

  const records: RecordNode[] = []

  const walk = (at: string): void => {
    for (const name of fs.readdirSync(at)) {
      const full = path.join(at, name)

      if (fs.statSync(full).isDirectory()) {
        walk(full)
        continue
      }

      if (!name.endsWith('.tree')) {
        continue
      }

      try {
        const node = parseTree(fs.readFileSync(full, 'utf8'))

        // Checked HERE, where the file name is still known. `datasetOf` rejects a record
        // without a mark too, but by then the file is out of scope and the message names
        // only the form, which in a directory of five hundred records is not something a
        // person can act on.
        if (node.mark === undefined) {
          refuse('This record has no mark line, so it has no identity', { fields: [location(path.relative(root, full))] })
        }

        records.push(node)
      } catch (error) {
        // Named, and fatal. A commit that silently skipped a file it could not read would
        // record a DELETION of that record, because the dataset is the whole working state
        // rather than a list of edits.
        const message = error instanceof Error ? error.message : String(error)
        refuse(message.charAt(0).toUpperCase() + message.slice(1), { fields: [location(path.relative(root, full))] })
      }
    }
  }

  walk(dir)

  return datasetOf(records)
}

/**
 * What the working files would change, against a branch.
 *
 * The read half of `commit`, so a person can see what is about to happen before it does.
 */
export function callBaseStatus(input: { root: string; branch: string }): void {
  openRun({ verb: 'status', root: input.root, facts: [input.branch] })
  const { repo } = need(input.root)
  const now = working(input.root)
  const head = repo.head(input.branch)
  const before = head ? repo.checkout(head) : new Map()

  const added = [...now.keys()].filter(mark => !before.has(mark))
  const gone = [...before.keys()].filter(mark => !now.has(mark))
  const changed = [...now.keys()].filter(
    mark =>
      before.has(mark) &&
      canonicalizeRecord(now.get(mark)!) !== canonicalizeRecord(before.get(mark)!),
  )

  const lines: string[] = []

  for (const mark of added.sort()) {
    lines.push(`+ ${mark}`)
  }

  for (const mark of changed.sort()) {
    lines.push(`~ ${mark}`)
  }

  // A record absent from the working files is a REMOVAL, because the dataset is the whole
  // state. Said plainly, because the surprising way to lose a record is to move its file.
  for (const mark of gone.sort()) {
    lines.push(`- ${mark}  (absent from ${WORK}/, so committing would remove it)`)
  }

  printLines(lines)
  closeRun({
    verdict: `${now.size} record${now.size === 1 ? '' : 's'} in ${WORK}/`,
    counts: [count(added.length, 'new'), count(changed.length, 'changed'), count(gone.length, 'removed')],
  })
}

/** Commit the working files onto a branch. */
export function callBaseCommit(input: {
  root: string
  branch: string
  message: string
  author: string
}): void {
  openRun({ verb: 'commit', root: input.root, facts: [input.branch] })
  const { repo, save } = need(input.root)
  const next = working(input.root)

  if (!next.size) {
    refuse(`There are no records in ${WORK}/`, {
      message: ['Committing would empty the branch, so this refuses rather than doing it by accident.'],
      next: 'term base status',
    })
  }

  const done = repo.commit(input.branch, {
    author: input.author,
    time: Date.now(),
    message: input.message,
  }, next)

  if (!done.ok) {
    // each refusal its own item, the record it is about as its subject
    for (const one of done.diagnostics ?? []) {
      report({ glyph: 'failed', kind: 'problem', subject: one.message, fields: [field('mark', one.mark ?? '(dataset)')] })
    }

    for (const one of done.conflicts ?? []) {
      report({ glyph: 'failed', kind: 'problem', subject: 'A conflict', message: [JSON.stringify(one)] })
    }

    closeRun({ verdict: 'The commit was refused' })

    return
  }

  save()

  // the hash is what a script captures, so it is data
  printData(`${done.commit}\n`)
  closeRun({ verdict: `Committed onto ${input.branch}`, counts: [count(next.size, 'records', 'record')] })
}

/** Write a commit's records back out as `.tree` files. */
export function callBaseCheckout(input: {
  root: string
  commit: string
}): void {
  openRun({ verb: 'write', root: input.root, facts: [input.commit] })
  const { repo } = need(input.root)
  const at = resolve(repo, input.commit)
  const dataset = repo.checkout(at)
  const dir = path.join(input.root, WORK)

  fs.mkdirSync(dir, { recursive: true })

  for (const [mark, node] of dataset) {
    const into = path.join(dir, node.type)

    fs.mkdirSync(into, { recursive: true })
    fs.writeFileSync(path.join(into, `${mark}.tree`), formatTree(node))
  }

  closeRun({ verdict: `Records written into ${WORK}/`, counts: [count(dataset.size, 'records', 'record')] })
}

/** Merge one branch into another. */
export function callBaseMerge(input: {
  root: string
  into: string
  from: string
  author: string
}): void {
  openRun({ verb: 'merge', root: input.root, subject: `${input.from} into ${input.into}` })
  const { repo, save } = need(input.root)
  const done = repo.merge(input.into, input.from, {
    author: input.author,
    time: Date.now(),
    message: `merge ${input.from} into ${input.into}`,
  })

  if (!done.ok) {
    // Conflicts are RETURNED rather than resolved, so a person decides. Printing them per
    // field is the point: "merge failed" would leave nothing to act on.
    for (const one of done.conflicts) {
      report({ glyph: 'failed', kind: 'problem', subject: 'A conflict', message: [JSON.stringify(one)] })
    }

    closeRun({ verdict: 'The merge stopped on conflicts', counts: [count(done.conflicts.length, 'conflicts', 'conflict')] })

    return
  }

  save()

  if (done.alreadyUpToDate) {
    closeRun({ verdict: `${input.into} already has ${input.from}` })

    return
  }

  printData(`${done.commit}\n`)
  closeRun({ verdict: `Merged ${input.from} into ${input.into}` })
}

/** Name a commit, so it can be cited. */
export function callBaseTag(input: {
  root: string
  name: string
  commit?: string
  branch: string
}): void {
  openRun({ verb: 'tag', root: input.root, subject: input.name })
  const { repo, save } = need(input.root)
  const at = input.commit
    ? resolve(repo, input.commit)
    : repo.head(input.branch)

  if (!at) {
    refuse(`There is nothing to tag: ${input.branch} has no commits`)
  }

  if (!repo.createTag(input.name, at)) {
    refuse(`A tag named ${input.name} already exists`)
  }

  save()

  printData(`${input.name} -> ${at}\n`)
  closeRun({ verdict: `Tagged ${input.name}` })
}

/**
 * A projected cell as a person reads it.
 *
 * `rowsFor` returns base `Value` objects rather than scalars, because unwrapping to a driver
 * parameter happens later in `writesFor`. Printing the KIND alone would show that a column is
 * present without showing what lands in it, and the reason to run this at all is to see what
 * a mapping produces.
 */
function cell(value: unknown): string {
  if (value && typeof value === 'object' && 'kind' in value) {
    const held = value as { kind: string; value?: unknown; target?: string }

    switch (held.kind) {
      case 'null':
        return '(null)'
      case 'ref':
        return `-> ${held.target}`
      case 'blob':
        return '(blob)'
      case 'collection':
      case 'record':
        return `(${held.kind})`
      default:
        return String(held.value)
    }
  }

  return String(value)
}

/**
 * The working tree at a commit, as `.tree` files somebody can read without our software.
 *
 * Distinct from `checkout`, which writes into `record/` so the repository can be worked on.
 * This writes wherever you point it and is for handing the data to somebody else.
 */
export function callBaseExport(input: {
  root: string
  commit: string
  out: string
}): void {
  openRun({ verb: 'export', root: input.root, facts: [input.commit] })
  const { repo } = need(input.root)
  const at = resolve(repo, input.commit)
  let files = 0
  let bytes = 0

  walkTree({ repo, commit: at }, entry => {
    const full = path.join(input.out, entry.path)

    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, entry.bytes)
    files += 1
    bytes += Buffer.byteLength(entry.bytes)
  })

  report({ glyph: 'done', verb: 'write', subject: input.out, bytes, counts: [count(files, 'files', 'file')] })
  closeRun({ verdict: `Exported to ${input.out}` })
}

/**
 * What a projection WOULD write for a commit.
 *
 * Reports, and cannot write. That is a scoping decision rather than a missing half: the
 * language package has no database driver and should not gain one for a single verb, so
 * actually writing a projection lives in mesh, where the Postgres engine and the durable
 * stores already are (`pnpm check:rebuild` and the projection runner).
 *
 * What this gives a person is the thing that is genuinely hard to see otherwise: exactly
 * which rows and columns a mapping produces, offline, before anything touches a database.
 * A mapping that drops a field is visible here as a column that is simply absent.
 *
 * The mapping comes from a file because the CLI has no schema to introspect. In mesh it is
 * DERIVED from the live target instead, which is the right source there and unavailable here.
 */
/**
 * What a projection would write, and optionally write it.
 *
 * TWO MODES, and the difference is where the schema comes from.
 *
 * With no `--mapping`, the schema is INFERRED FROM THE RECORDS: a form becomes a table, a
 * field a column, a value's kind a column type. That is the case a fresh database is, and
 * it is what makes this an on-ramp rather than a thing you can only use if you already had
 * the tables. Writing in this mode CREATES them.
 *
 * With `--mapping`, an existing schema is being adopted, so the tables are assumed to be
 * there and nothing is created. A mapping file says how records land in tables somebody
 * else already designed.
 *
 * REPORTS BY DEFAULT AND WRITES ONLY ON `--commit`, because `--into` points at a real
 * database and the safe direction has to be the one you get by forgetting a flag. Without
 * it, the rows and the schema are printed and nothing is touched.
 *
 * One row is printed IN FULL rather than only a count, because a count cannot show that a
 * column is missing, which is the thing a mapping gets wrong.
 */
export async function callBaseProject(input: {
  root: string
  commit: string
  mapping?: string
  into?: string
  commitWrite: boolean
  repository?: string
}): Promise<void> {
  openRun({ verb: 'project', root: input.root, facts: [input.commit, input.mapping ? 'mapping' : 'inferred'] })
  const { repo } = need(input.root)
  const at = resolve(repo, input.commit)
  const dataset = repo.checkout(at)

  let mapping!: Mapping
  let forms: Array<TableForm> | undefined

  if (input.mapping === undefined) {
    try {
      const inferred = inferProjection({ dataset })

      mapping = inferred.mapping
      forms = inferred.forms
    } catch (error) {
      refuse(
        error instanceof MixedField
          ? error.message
          : `Could not work out a schema: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  } else {
    if (!fs.existsSync(input.mapping)) {
      refuse(`There is no mapping file at ${input.mapping}`)
    }

    try {
      mapping = JSON.parse(fs.readFileSync(input.mapping, 'utf8')) as Mapping
    } catch (error) {
      refuse(`${input.mapping} is not readable JSON`, { message: [error instanceof Error ? error.message : String(error)] })
    }
  }

  const rows = rowsFor({ mapping, dataset })

  if (!rows.size) {
    closeRun({ verdict: 'This mapping produces no rows for that commit', counts: [count(0, 'rows', 'row')] })

    return
  }

  // what a projection WOULD write is data: every table with its row count, and one row in full, so a column a mapping
  // drops shows as absent
  let total = 0
  const lines: string[] = []

  for (const table of [...rows.keys()].sort()) {
    const held = rows.get(table)!

    lines.push(`${table}  ${held.length} row(s)`)
    total += held.length

    const first = held[0]

    if (first) {
      for (const [column, value] of [...first].sort()) {
        lines.push(`    ${column.padEnd(24)} ${cell(value)}`)
      }
    }
  }

  printLines(lines)
  const tally = [count(total, 'rows', 'row'), count(rows.size, 'tables', 'table')]

  if (input.into === undefined) {
    closeRun({ verdict: 'Nothing was written', counts: tally, next: 'term base project <commit> --into <url>, to write it into Postgres' })

    return
  }

  if (!input.commitWrite) {
    closeRun({
      verdict: 'Nothing was written',
      counts: tally,
      message: [forms ? '--write creates the tables.' : 'The tables must already exist, because --mapping says the schema is somebody else\'s.'],
      next: 'add --write, to write them into the database at --into',
    })

    return
  }

  const repository = input.repository ?? repositoryName(input.root)

  if (!isMark(repository)) {
    refuse('--repository must be a uuid version 4', {
      message: ["A projection's bookkeeping is keyed by one."],
      fields: [field('gave', repository)],
    })
  }

  const pool = await openPostgres(input.into)

  try {
    const projector = new Projector(postgresEngine(pool), repository, mapping)

    // With an inferred schema the tables are ours to make. With a mapping file they are
    // somebody else's, so only the projector's own bookkeeping is installed.
    await projector.install(forms ?? [])

    // From wherever this projection already is, not from empty. The first run writes
    // everything; a later one writes only what changed, which is what makes projecting a
    // large repository after a small edit cheap instead of a full rewrite.
    const from = await projector.serving()
    const changes = commitChanges(repo, from, at)

    // Every commit the span folds is recorded as applied, not just the last one, so a
    // client that committed an intermediate commit reads it as applied rather than behind.
    const covers = repo.commitsBetween(from, at)

    const done = await projector.apply({
      commit: at,
      changes,
      ...(covers.length ? { covers } : {}),
    })

    if (!done.applied) {
      closeRun({ verdict: `Already serving ${at}` })

      return
    }

    report({
      glyph: 'done',
      verb: 'write',
      subject: repository,
      counts: [count(done.writes, 'statements', 'statement'), ...(forms ? [count(forms.length, 'tables created', 'table created')] : [])],
      facts: [from ? `from ${from.slice(0, 20)}` : 'from empty'],
    })
    closeRun({ verdict: `Serving ${at}` })
  } finally {
    await pool.end()
  }
}
