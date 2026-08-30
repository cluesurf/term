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

import { Repository } from '@term/base/code/repo/repo'
import { isMark, mintMark } from '@term/base/code/base/mark'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { MemoryRefStore } from '@term/base/code/store/ref-store'
import { commitChanges } from '@term/base/code/project/feed'
import { canonicalizeRecord } from '@term/base/code/canon/canonicalize'
import { FORMAT_REF } from '@term/base/code/canon/format'
import { exportTree } from '@term/base/code/api/export'
import { rowsFor } from '@term/base/code/project/projector'
import type { Mapping } from '@term/base/code/project/mapping'
import type { TableForm } from '@term/base/code/project/table'
import { MixedField, inferProjection } from '@term/base/code/project/infer'
import { Projector } from '@term/base/code/project/projector'
import { openPostgres, postgresEngine } from './base-engine'
import { parseTree } from '@term/base/code/tree/parse'
import { formatTree } from '@term/base/code/tree/format'
import { datasetOf, type Dataset } from '@term/base/code/diff/change'
import type { RecordNode } from '@term/base/code/base/type'

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
    console.error(
      `\`${given}\` matches ${hit.length} commits. Give more of it:\n` +
        hit.map(hash => `  ${hash}`).join('\n'),
    )
    process.exit(1)
  }

  console.error(`no commit matching \`${given}\``)
  process.exit(1)
}

export function need(root: string): {
  repo: Repository
  refs: MemoryRefStore
  save: () => void
} {
  const held = open(root)

  if (!held) {
    console.error(
      `no repository here. \`${HOME}/\` is missing.\n` +
        'Run `term base init` in the directory you want to track.',
    )
    process.exit(1)
  }

  return held
}

/** Every branch, and where it points. */
export function callBaseLog(input: { root: string; branch?: string }): void {
  const { repo } = need(input.root)
  const branches = input.branch ? [input.branch] : repo.branches()

  if (!branches.length) {
    console.log('no branches yet')

    return
  }

  for (const branch of branches) {
    const head = repo.head(branch)

    if (!head) {
      console.log(`${branch}: no commits`)
      continue
    }

    console.log(`${branch}`)

    for (const { hash, commit } of repo.log(branch)) {
      const when = new Date(commit.time).toISOString().slice(0, 19).replace('T', ' ')

      console.log(`  ${hash.slice(0, 24)}  ${when}  ${commit.author}  ${commit.message}`)
    }
  }
}

/** What changed between two commits, as field-level changes. */
export function callBaseDiff(input: {
  root: string
  from?: string
  to: string
}): void {
  const { repo } = need(input.root)
  const to = resolve(repo, input.to)
  const from = input.from === undefined ? undefined : resolve(repo, input.from)
  const changes = commitChanges(repo, from, to)

  if (!changes.length) {
    console.log('no changes')

    return
  }

  for (const change of changes) {
    switch (change.type) {
      case 'record.add':
        console.log(`+ ${change.mark}  ${change.value.type}`)
        break
      case 'record.remove':
        console.log(`- ${change.mark}`)
        break
      case 'field.set':
        console.log(`~ ${change.mark}  ${change.field}`)
        break
      case 'field.remove':
        console.log(`~ ${change.mark}  ${change.field} removed`)
        break
      default:
        break
    }
  }

  console.log(`\n${changes.length} change(s)`)
}

/** One record as of a commit, in canonical form. */
export function callBaseShow(input: {
  root: string
  commit: string
  mark: string
}): void {
  const { repo } = need(input.root)
  const at = resolve(repo, input.commit)
  const found = repo.recordAt(at, input.mark)

  if (!found) {
    console.error(`no record ${input.mark} at ${input.commit}`)
    process.exit(1)
  }

  // Both, and in this order. The readable half is what a person needs to learn the record
  // model, which is what a read verb is for. The canonical half is what is HASHED, and
  // showing only a pretty print would leave the one thing a person cannot otherwise check
  // invisible: whether the bytes about to be trusted are the bytes they think.
  console.log(`mark  ${input.mark}`)
  console.log(`form  ${found.type}`)

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

    console.log(`  ${field.padEnd(20)} ${said}`)
  }

  console.log(`\ncanonical bytes, which are what is hashed:`)
  console.log(canonicalizeRecord(found))
}

/** Whether a repository is coherent, and what it holds. */
export function callBaseCheck(input: { root: string }): void {
  const { repo, refs } = need(input.root)
  const report = repo.fsck()

  // Read the ref DIRECTLY. `repo.head(name)` prepends `branch/`, so asking it for
  // `meta/format` looks for `branch/meta/format` and always answers undefined, which made
  // this print "(unversioned)" on a repository that was correctly versioned. The gate was
  // working; only the display was wrong.
  console.log(`format      ${refs.get(FORMAT_REF) ?? '(unversioned)'}`)
  console.log(`branches    ${repo.branches().join(', ') || '(none)'}`)
  console.log(`tags        ${repo.tags().join(', ') || '(none)'}`)

  if (report.missing.length) {
    console.error(`\n${report.missing.length} missing chunk(s):`)

    for (const hash of report.missing.slice(0, 10)) {
      console.error(`  ${hash}`)
    }

    process.exit(1)
  }

  console.log('\nno missing chunks')
}

/** Every record at a commit, by mark and form. */
export function callBaseList(input: { root: string; commit: string }): void {
  const { repo } = need(input.root)
  const dataset = repo.checkout(resolve(repo, input.commit))

  for (const mark of [...dataset.keys()].sort()) {
    console.log(`${mark}  ${dataset.get(mark)!.type}`)
  }

  console.log(`\n${dataset.size} record(s)`)
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
  const home = path.join(input.root, HOME)

  if (fs.existsSync(home)) {
    console.error(`already a repository: ${HOME}/ exists`)
    process.exit(1)
  }

  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, CHUNKS), '{}\n')
  fs.writeFileSync(path.join(home, REFS), '{}\n')
  fs.writeFileSync(path.join(home, NAME), `${mintMark()}\n`)

  console.log(`initialised an empty repository in ${HOME}/`)
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
          console.error(
            `${path.relative(root, full)}: no \`mark\` line, so this record has no identity`,
          )
          process.exit(1)
        }

        records.push(node)
      } catch (error) {
        // Named, and fatal. A commit that silently skipped a file it could not read would
        // record a DELETION of that record, because the dataset is the whole working state
        // rather than a list of edits.
        console.error(
          `${path.relative(root, full)}: ${error instanceof Error ? error.message : String(error)}`,
        )
        process.exit(1)
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

  for (const mark of added.sort()) {
    console.log(`+ ${mark}`)
  }

  for (const mark of changed.sort()) {
    console.log(`~ ${mark}`)
  }

  // A record absent from the working files is a REMOVAL, because the dataset is the whole
  // state. Said plainly, because the surprising way to lose a record is to move its file.
  for (const mark of gone.sort()) {
    console.log(`- ${mark}  (absent from ${WORK}/, so committing would remove it)`)
  }

  console.log(
    `\n${now.size} record(s) in ${WORK}/, ${added.length} new, ${changed.length} changed, ${gone.length} removed`,
  )
}

/** Commit the working files onto a branch. */
export function callBaseCommit(input: {
  root: string
  branch: string
  message: string
  author: string
}): void {
  const { repo, save } = need(input.root)
  const next = working(input.root)

  if (!next.size) {
    console.error(
      `no records in ${WORK}/. Committing would empty the branch, so this refuses rather ` +
        'than doing it by accident. Use `term base status` to see what is there.',
    )
    process.exit(1)
  }

  const done = repo.commit(input.branch, {
    author: input.author,
    time: Date.now(),
    message: input.message,
  }, next)

  if (!done.ok) {
    console.error('refused:')

    for (const one of done.diagnostics ?? []) {
      console.error(`  ${one.mark ?? '(dataset)'}  ${one.message}`)
    }

    for (const one of done.conflicts ?? []) {
      console.error(`  conflict on ${JSON.stringify(one)}`)
    }

    process.exit(1)
  }

  save()

  console.log(`${done.commit}`)
  console.log(`${next.size} record(s) on ${input.branch}`)
}

/** Write a commit's records back out as `.tree` files. */
export function callBaseCheckout(input: {
  root: string
  commit: string
}): void {
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

  console.log(`wrote ${dataset.size} record(s) into ${WORK}/`)
}

/** Merge one branch into another. */
export function callBaseMerge(input: {
  root: string
  into: string
  from: string
  author: string
}): void {
  const { repo, save } = need(input.root)
  const done = repo.merge(input.into, input.from, {
    author: input.author,
    time: Date.now(),
    message: `merge ${input.from} into ${input.into}`,
  })

  if (!done.ok) {
    // Conflicts are RETURNED rather than resolved, so a person decides. Printing them per
    // field is the point: "merge failed" would leave nothing to act on.
    console.error(`${done.conflicts.length} conflict(s):`)

    for (const one of done.conflicts) {
      console.error(`  ${JSON.stringify(one)}`)
    }

    process.exit(1)
  }

  save()

  console.log(
    done.alreadyUpToDate
      ? `${input.into} already has ${input.from}`
      : `${done.commit}`,
  )
}

/** Name a commit, so it can be cited. */
export function callBaseTag(input: {
  root: string
  name: string
  commit?: string
  branch: string
}): void {
  const { repo, save } = need(input.root)
  const at = input.commit
    ? resolve(repo, input.commit)
    : repo.head(input.branch)

  if (!at) {
    console.error(`nothing to tag: ${input.branch} has no commits`)
    process.exit(1)
  }

  if (!repo.createTag(input.name, at)) {
    console.error(`a tag named \`${input.name}\` already exists`)
    process.exit(1)
  }

  save()

  console.log(`${input.name} -> ${at}`)
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
  const { repo } = need(input.root)
  const at = resolve(repo, input.commit)
  let count = 0

  for (const entry of exportTree({ repo, commit: at })) {
    const full = path.join(input.out, entry.path)

    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, entry.bytes)
    count += 1
  }

  console.log(`exported ${count} file(s) to ${input.out}`)
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
  const { repo } = need(input.root)
  const at = resolve(repo, input.commit)
  const dataset = repo.checkout(at)

  let mapping: Mapping
  let forms: Array<TableForm> | undefined

  if (input.mapping === undefined) {
    try {
      const inferred = inferProjection({ dataset })

      mapping = inferred.mapping
      forms = inferred.forms
    } catch (error) {
      console.error(
        error instanceof MixedField
          ? error.message
          : `could not work out a schema: ${error instanceof Error ? error.message : String(error)}`,
      )
      process.exit(1)
    }
  } else {
    if (!fs.existsSync(input.mapping)) {
      console.error(`no mapping file at ${input.mapping}`)
      process.exit(1)
    }

    try {
      mapping = JSON.parse(fs.readFileSync(input.mapping, 'utf8')) as Mapping
    } catch (error) {
      console.error(
        `${input.mapping} is not readable json: ${error instanceof Error ? error.message : String(error)}`,
      )
      process.exit(1)
    }
  }

  const rows = rowsFor({ mapping, dataset })

  if (!rows.size) {
    console.log('this mapping produces no rows for that commit')

    return
  }

  let total = 0

  for (const table of [...rows.keys()].sort()) {
    const held = rows.get(table)!

    console.log(`${table}  ${held.length} row(s)`)
    total += held.length

    const first = held[0]

    if (first) {
      for (const [column, value] of [...first].sort()) {
        console.log(`    ${column.padEnd(24)} ${cell(value)}`)
      }
    }
  }

  if (input.into === undefined) {
    console.log(`\n${total} row(s) across ${rows.size} table(s). Nothing was written.`)
    console.log('Pass --into <url> to write it into a Postgres database.')

    return
  }

  if (!input.commitWrite) {
    console.log(
      `\n${total} row(s) across ${rows.size} table(s). NOTHING WAS WRITTEN.\n` +
        `Pass --write to write them into the database at --into` +
        (forms ? ', creating the tables.' : '. The tables must already exist, because --mapping says the schema is somebody else\'s.'),
    )

    return
  }

  const repository = input.repository ?? repositoryName(input.root)

  if (!isMark(repository)) {
    console.error(
      `--repository must be a uuid version 4, because a projection's bookkeeping is keyed by one. Got ${repository}`,
    )
    process.exit(1)
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
      console.log(`\nalready serving ${at}. Nothing to do.`)

      return
    }

    console.log(
      `\nwrote ${done.writes} statement(s) into \`${repository}\`` +
        (forms ? `, creating ${forms.length} table(s)` : '') +
        (from ? `, advancing from ${from.slice(0, 20)}` : ', from empty'),
    )
    console.log(`serving ${at}`)
  } finally {
    await pool.end()
  }
}
