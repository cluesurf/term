// Term data: the `host` dialect. Tree syntax with five heads (`host`, `list`, `mesh`, `tree`, `fuse`) and six
// literals, no code. This module is the compiler's reader and writer for it: it recognizes a data file, walks the
// parser's tree into a `Data` value with every rule of the grammar reported as a diagnostic, expands anchors,
// writes the long and the compact spelling, and converts to and from JSON with key case changed at that boundary
// and nowhere else. `term make`, `term mold` and the tests all go through here, and `@term/host` (the Term-side
// package) is checked against it. See note/term/host/. Pure and browser-safe.
//
// The reading, the expanding, the writing, the formatting and the stream are compile/host-data.tree (self-hosting,
// 2026-10-06). This face keeps the shapes callers hold and the JSON, which is a conversion to and from `unknown`.
// Two tags are renamed at this boundary: Term cannot name a case `void` or `fuse`, so the port calls them `blank` and
// `graft`. An anchor is tagged on `hold` there, and written back here as `{ name, hold, list }`.

import type { RootNode, NameNode, TextNode } from '@term/make/code/parser/narrow'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import * as port from '@term/make/code/compile/host-data'

// ---- the value ----

export type Data =
  | { kind: 'hash'; list: DataEntry[] }
  | { kind: 'list'; list: Data[] }
  | { kind: 'text'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'decimal'; value: number }
  | { kind: 'flag'; value: boolean }
  | { kind: 'void' }
  // an unexpanded `fuse <name>`, present only before `expandData`
  | { kind: 'fuse'; name: string }

export type DataEntry = { name: string; base: Data }

// an anchor: the entries or items of a `tree <name>`
export type DataTree = {
  name: string
  // entries (to fuse into a hash) or items (to fuse into a list), decided by the first child
  hold: 'hash' | 'list'
  list: DataEntry[] | Data[]
}

export type DataFile = {
  // the root: a hash of the top-level entries, or a list of the top-level `mesh` items
  root: Data
  trees: Map<string, DataTree>
}

// ---- the boundary ----

function toPort(data: Data): port.HostValue {
  switch (data.kind) {
    case 'hash':
      return { kind: 'hash', list: data.list.map(entry => ({ name: entry.name, base: toPort(entry.base) })) }
    case 'list':
      return { kind: 'list', list: data.list.map(toPort) }
    case 'void':
      return { kind: 'blank' }
    case 'fuse':
      return { kind: 'graft', name: data.name }
    default:
      return data
  }
}

function fromPort(value: port.HostValue): Data {
  switch (value.kind) {
    case 'hash':
      return { kind: 'hash', list: value.list.map(entry => ({ name: entry.name, base: fromPort(entry.base) })) }
    case 'list':
      return { kind: 'list', list: value.list.map(fromPort) }
    case 'blank':
      return { kind: 'void' }
    case 'graft':
      return { kind: 'fuse', name: value.name }
    default:
      return value
  }
}

function treesToPort(trees: Map<string, DataTree>): Map<string, port.HostAnchor> {
  const out = new Map<string, port.HostAnchor>()

  for (const [key, anchor] of trees) {
    out.set(
      key,
      anchor.hold === 'hash'
        ? { hold: 'hash', name: anchor.name, list: (anchor.list as DataEntry[]).map(e => ({ name: e.name, base: toPort(e.base) })) }
        : { hold: 'list', name: anchor.name, list: (anchor.list as Data[]).map(toPort) },
    )
  }

  return out
}

function treesFromPort(trees: Map<string, port.HostAnchor>): Map<string, DataTree> {
  const out = new Map<string, DataTree>()

  for (const [key, anchor] of trees) {
    out.set(
      key,
      anchor.hold === 'hash'
        ? { name: anchor.name, hold: 'hash', list: anchor.list.map(e => ({ name: e.name, base: fromPort(e.base) })) }
        : { name: anchor.name, hold: 'list', list: anchor.list.map(fromPort) },
    )
  }

  return out
}

function maybeTrees(trees: Map<string, DataTree> | undefined): port.Maybe<Map<string, port.HostAnchor>> {
  return trees ? { form: 'some', value: treesToPort(trees) } : { form: 'none' }
}

function fileRead(read: port.HostRead): { ok: true; data: DataFile } | { ok: false; diagnostics: Diagnostic[] } {
  if (!read.ok) {
    return { ok: false, diagnostics: read.diagnostics }
  }

  return { ok: true, data: { root: fromPort(read.file.root), trees: treesFromPort(read.file.trees) } }
}

// ---- recognizing a data file ----

// a `.tree` whose top-level heads are all data heads, and in which no `host` carries a `code` or `text` head (a
// code file of constants writes `host x, code 10`; data writes `host x, 10`)
export function isDataFile(source: { file: string; text: string }): boolean {
  return port.isDataFile(source)
}

// the same question of a tree already parsed (the editor path parses once)
export function isDataTree(tree: RootNode): boolean {
  return port.isDataTree(tree as never)
}

// ---- the tree, read ----

export function readDataText(
  source: {
    file: string
    text: string
  },
  lean = false,
): { ok: true; data: DataFile } | { ok: false; diagnostics: Diagnostic[] } {
  return fileRead(port.readDataText(source, lean))
}

// `lean`: the file's role carries `mark lean`, and a head the dialect does not know, carrying a value, is a
// `host` entry keyed by that head. `a 10` is `host a, 10`, `key <tense>` is `host key, <tense>`, and a head over
// a block is a map entry. `list` stays `list`, so a one-element list is still written `list x / 5` and the count
// of values never decides what an entry is. The lean form is only ever read under the mark: the content rule
// (`isDataTree`) does not know it, so an unmarked file full of bare heads is not data. note/term/lean.md.
export function readData(
  tree: RootNode,
  file: string,
  lean = false,
): { ok: true; data: DataFile } | { ok: false; diagnostics: Diagnostic[] } {
  return fileRead(port.readData(tree as never, file, lean))
}

// ---- anchors ----

export function expandData(
  data: DataFile,
  file = 'data.tree',
): { ok: true; data: Data } | { ok: false; diagnostics: Diagnostic[] } {
  const expanded = port.expandData({ root: toPort(data.root), trees: treesToPort(data.trees) }, file)

  return expanded.ok ? { ok: true, data: fromPort(expanded.value) } : { ok: false, diagnostics: expanded.diagnostics }
}

// ---- writing ----

export function writeLong(data: Data, trees?: Map<string, DataTree>): string {
  return port.writeLong(toPort(data), maybeTrees(trees))
}

export function writeCompact(data: Data, trees?: Map<string, DataTree>): string {
  return port.writeCompact(toPort(data), maybeTrees(trees))
}

// one compact line per top-level form, the way a stream is written
export function writeLines(data: Data, trees?: Map<string, DataTree>): string {
  return port.writeLines(toPort(data), maybeTrees(trees))
}

// a value written as the inside of a text literal, every character it holds read back as itself by `unescape-text`
// (compile/surface.tree). `term test` writes a stored snapshot into a test this way (call/code/test-preprocess.ts)
export function escapeText(value: string): string {
  return port.escapeText(value)
}

// ---- JSON ----

const SAFE = 2 ** 53

export function toJson(data: Data, keep = false): string {
  return JSON.stringify(toJsonValue(data, keep), null, 0)
}

export function toJsonValue(data: Data, keep = false): unknown {
  switch (data.kind) {
    case 'hash': {
      const out: Record<string, unknown> = {}

      for (const entry of data.list) {
        out[keep ? entry.name : snake(entry.name)] = toJsonValue(entry.base, keep)
      }

      return out
    }
    case 'list':
      return data.list.map(i => toJsonValue(i, keep))
    case 'text':
      return data.value
    case 'number':
      // past 2^53 a JSON number loses digits, so it travels as text
      return Math.abs(data.value) >= SAFE ? String(data.value) : data.value
    case 'decimal':
      return data.value
    case 'flag':
      return data.value
    case 'void':
      return null
    case 'fuse':
      return null
  }
}

export function fromJson(text: string): Data {
  return fromJsonValue(JSON.parse(text) as unknown)
}

export function fromJsonValue(value: unknown): Data {
  if (value === null || value === undefined) {
    return { kind: 'void' }
  }

  if (Array.isArray(value)) {
    return { kind: 'list', list: value.map(fromJsonValue) }
  }

  switch (typeof value) {
    case 'string':
      return { kind: 'text', value }
    case 'number':
      return Number.isInteger(value)
        ? { kind: 'number', value }
        : { kind: 'decimal', value }
    case 'boolean':
      return { kind: 'flag', value }
    case 'object': {
      const list: DataEntry[] = []

      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        list.push({ name: kebab(key), base: fromJsonValue(item) })
      }

      return { kind: 'hash', list }
    }
    default:
      return { kind: 'void' }
  }
}

// kebab in the file, snake at the JSON boundary. A key that is not a name is left alone, both ways.
export function snake(key: string): string {
  return port.hostSnake(key)
}

export function kebab(key: string): string {
  return port.hostKebab(key)
}

// ---- formatting a data file, comments kept ----

// is every top-level form written in the compact spelling (`h(`, `l(`, `m(`, `t(`, `f(`)? Such a file is formatted
// one form per line, the way a stream is written
export function isCompactTree(tree: RootNode): boolean {
  return port.isCompactTree(tree as never)
}

// the canonical form straight from the tree, so a comment survives `term form`. Byte for byte what `writeLong`
// (or `writeCompact` for a compact file) gives for the same value when the file carries no comments. Call it only
// on a tree `readData` accepted: it lays out, it does not check.
export function formatData(tree: RootNode, file: string): string {
  return port.formatData(tree as never, file)
}

// ---- a stream ----

// a compact stream: one form per line, a `t(` line declaring (or re-declaring) an anchor for every line after it,
// `h(` / `l(` lines the entries of a map or `m(` lines the items of a list, never both. Blank lines and `#` lines
// are skipped. Each line is expanded against the anchors declared so far. See note/term/host/07-streaming.md.
export function readStream(source: {
  file: string
  text: string
}): { ok: true; data: Data; lines: number } | { ok: false; diagnostics: Diagnostic[] } {
  const read = port.readStream(source)

  return read.ok ? { ok: true, data: fromPort(read.value), lines: read.lines } : { ok: false, diagnostics: read.diagnostics }
}

// ---- the keys of a value ----

export type DataKey = { path: string; kind: string; value: string }

// every key of a value as a flat list, a path per row: `x/y/z number 123`. A map or a list row says how many it
// holds. What `term look` prints for a data file.
export function dataKeys(data: Data): DataKey[] {
  return port.dataKeys(toPort(data))
}

// the source text of a name or a text, unescaped. `{` is a literal brace in data, so an interpolation part is
// put back as the characters it was written with.
export function literalText(node: NameNode | TextNode): string {
  return port.literalText(node as never)
}
