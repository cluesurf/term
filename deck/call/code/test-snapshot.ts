// A test file's snapshots (decisions-2026-10.md, D11): `<test>.snapshot.tree` beside it, a Term data file holding a
// hash from each test's phrase to the list of the texts its `want snapshot`s hold, in order:
//
//   list <renders a page>
//     <\<h1\>Hello\</h1\>>, <second>
//
// Read and written through the data reader and writer every data file goes through (compile/host.ts), so `term form`,
// `term mold` and `term look` read it as they read any other. `term test --update` writes it; a run without the flag
// only reads it (call/code/test-preprocess.ts `snapshotWant`).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readDataText, writeLong } from '@term/make/code/compile/host'
import type { Data } from '@term/make/code/compile/host'

const SUFFIX = '.snapshot.tree'

// whether a file is a snapshot store, never a test file of its own
export function isSnapshotFile(file: string): boolean {
  return file.endsWith(SUFFIX)
}

// where a test file's snapshots are kept
export function snapshotFileOf(testFile: string): string {
  return testFile.replace(/\.tree$/, SUFFIX)
}

// a test file's stored snapshots by phrase, empty when it has none, or why the store could not be read
export function readSnapshots(testFile: string): { stored: Map<string, string[]> } | { problem: string } {
  const file = snapshotFileOf(testFile)
  const stored = new Map<string, string[]>()

  if (!existsSync(file)) {
    return { stored }
  }

  const read = readDataText({ file, text: readFileSync(file, 'utf8') })

  if (!read.ok) {
    return { problem: `${file} is not a data file: ${read.diagnostics[0]?.message ?? 'it did not parse'}` }
  }

  if (read.data.root.kind !== 'hash') {
    return { problem: `${file} holds a ${read.data.root.kind}, where a hash from each test's phrase to its snapshots goes` }
  }

  for (const entry of read.data.root.list) {
    const texts = entry.base.kind === 'list' ? entry.base.list : [entry.base]

    if (texts.some(one => one.kind !== 'text')) {
      return { problem: `${file}: the snapshots of "${entry.name}" are not all text` }
    }

    stored.set(entry.name, texts.map(one => (one as { value: string }).value))
  }

  return { stored }
}

// write a test file's snapshots: those taken this run replace the test's stored ones whole, a test that took none keeps
// what it had, and a phrase the file no longer holds is dropped. Nothing is written when there is nothing to keep
export function writeSnapshots(input: {
  testFile: string
  stored: Map<string, string[]>
  taken: Map<string, string[]>
  // every test phrase the file holds now, in source order
  phrases: string[]
}): { written: number } {
  const kept = input.phrases.flatMap(phrase => {
    const texts = input.taken.get(phrase) ?? input.stored.get(phrase)

    return texts && texts.length > 0 ? [{ phrase, texts }] : []
  })
  const file = snapshotFileOf(input.testFile)

  if (kept.length === 0) {
    return { written: 0 }
  }

  const root: Data = {
    kind: 'hash',
    list: kept.map(one => ({ name: one.phrase, base: { kind: 'list', list: one.texts.map(value => ({ kind: 'text', value })) } })),
  }

  writeFileSync(file, writeLong(root))

  return { written: kept.reduce((sum, one) => sum + one.texts.length, 0) }
}
