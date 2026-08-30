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
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { MemoryRefStore } from '@term/base/code/store/ref-store'
import { commitChanges } from '@term/base/code/project/feed'
import { canonicalizeRecord } from '@term/base/code/canon/canonicalize'
import { FORMAT_REF } from '@term/base/code/canon/format'

// Where a repository keeps itself, beside the working files, the way `.git` does.
const HOME = '.base'

const CHUNKS = 'chunk.json'
const REFS = 'ref.json'

/**
 * Load a repository from disk.
 *
 * The stores are the in-memory ones with their contents read from two JSON files, which is
 * enough for a local repository a person drives by hand and is deliberately not the
 * production substrate: the durable stores live in mesh and speak to Postgres and R2. Keeping
 * this simple means the CLI cannot be the reason a commit is lost.
 */
function open(root: string): { repo: Repository; save: () => void } | undefined {
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

  return { repo: new Repository(chunks, refs), save }
}

function need(root: string): { repo: Repository; save: () => void } {
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
  const changes = commitChanges(repo, input.from, input.to)

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
  const found = repo.recordAt(input.commit, input.mark)

  if (!found) {
    console.error(`no record ${input.mark} at ${input.commit}`)
    process.exit(1)
  }

  // canonical form rather than a pretty print, so what is shown is what is HASHED. A
  // display that differed from the canonical bytes would be the one place a person could
  // not check what they are about to trust.
  console.log(canonicalizeRecord(found))
}

/** Whether a repository is coherent, and what it holds. */
export function callBaseCheck(input: { root: string }): void {
  const { repo } = need(input.root)
  const report = repo.fsck()

  console.log(`format      ${repo.head(FORMAT_REF) ?? '(unversioned)'}`)
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
  const dataset = repo.checkout(input.commit)

  for (const mark of [...dataset.keys()].sort()) {
    console.log(`${mark}  ${dataset.get(mark)!.type}`)
  }

  console.log(`\n${dataset.size} record(s)`)
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

  console.log(`initialised an empty repository in ${HOME}/`)
}
