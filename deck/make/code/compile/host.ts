// Term data: the `host` dialect, five heads (`host`, `list`, `mesh`, `tree`, `fuse`) and six literals, no code. The
// reading, the expanding, the writing, the formatting and the stream are compile/host-data.tree, and JSON is
// compile/host-data-json.tree (item 0075). This face keeps the shapes callers hold. Term cannot name a case `void` or
// `fuse`, so the port calls them `blank` and `graft`, and the two tags are renamed here. An anchor is tagged on `hold`
// there, and written back here as `{ name, hold, list }`. See note/term/host/. Pure and browser-safe.

import type {
  RootNode,
  NameNode,
  TextNode,
} from '@term/make/code/parser/narrow'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import * as port from '@term/make/code/compile/host-data'
import * as json from '@term/make/code/compile/host-data-json'

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

// an anchor: the entries (to fuse into a hash) or items (to fuse into a list) of a `tree <name>`, by its first child
export type DataTree = {
  name: string
  hold: 'hash' | 'list'
  list: DataEntry[] | Data[]
}

// the root: a hash of the top-level entries, or a list of the top-level `mesh` items
export type DataFile = { root: Data; trees: Map<string, DataTree> }

type Read =
  | { ok: true; data: DataFile }
  | { ok: false; diagnostics: Diagnostic[] }

const entryTo = (entry: DataEntry): port.HostEntry => ({
  name: entry.name,
  base: toPort(entry.base),
})

const entryFrom = (entry: port.HostEntry): DataEntry => ({
  name: entry.name,
  base: fromPort(entry.base),
})

function toPort(data: Data): port.HostValue {
  switch (data.kind) {
    case 'hash':
      return { kind: 'hash', list: data.list.map(entryTo) }
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
      return { kind: 'hash', list: value.list.map(entryFrom) }
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

function treesToPort(
  trees: Map<string, DataTree>,
): Map<string, port.HostAnchor> {
  const out = new Map<string, port.HostAnchor>()

  for (const [key, { name, hold, list }] of trees) {
    out.set(
      key,
      hold === 'hash'
        ? { hold, name, list: (list as DataEntry[]).map(entryTo) }
        : { hold, name, list: (list as Data[]).map(toPort) },
    )
  }

  return out
}

function treesFromPort(
  trees: Map<string, port.HostAnchor>,
): Map<string, DataTree> {
  const out = new Map<string, DataTree>()

  for (const [key, anchor] of trees) {
    out.set(
      key,
      anchor.hold === 'hash'
        ? {
            name: anchor.name,
            hold: 'hash',
            list: anchor.list.map(entryFrom),
          }
        : {
            name: anchor.name,
            hold: 'list',
            list: anchor.list.map(fromPort),
          },
    )
  }

  return out
}

const maybeTrees = (
  trees?: Map<string, DataTree>,
): port.Maybe<Map<string, port.HostAnchor>> =>
  trees ? { form: 'some', value: treesToPort(trees) } : { form: 'none' }

const fileRead = (read: port.HostRead): Read =>
  read.ok
    ? {
        ok: true,
        data: {
          root: fromPort(read.file.root),
          trees: treesFromPort(read.file.trees),
        },
      }
    : { ok: false, diagnostics: read.diagnostics }

// a `.tree` whose top-level heads are all data heads, and in which no `host` carries a `code` or `text` head
export const isDataFile = (source: {
  file: string
  text: string
}): boolean => port.isDataFile(source)

// the same question of a tree already parsed (the editor path parses once)
export const isDataTree = (tree: RootNode): boolean =>
  port.isDataTree(tree as never)

export const readDataText = (
  source: { file: string; text: string },
  lean = false,
): Read => fileRead(port.readDataText(source, lean))

// `lean`: the file's role carries `mark lean`, and a head the dialect does not know, carrying a value, is a `host`
// entry keyed by that head (note/project/term/mill/lean.md)
export const readData = (
  tree: RootNode,
  file: string,
  lean = false,
): Read => fileRead(port.readData(tree as never, file, lean))

export function expandData(
  data: DataFile,
  file = 'data.tree',
): { ok: true; data: Data } | { ok: false; diagnostics: Diagnostic[] } {
  const expanded = port.expandData(
    { root: toPort(data.root), trees: treesToPort(data.trees) },
    file,
  )

  return expanded.ok
    ? { ok: true, data: fromPort(expanded.value) }
    : { ok: false, diagnostics: expanded.diagnostics }
}

export const writeLong = (
  data: Data,
  trees?: Map<string, DataTree>,
): string => port.writeLong(toPort(data), maybeTrees(trees))

export const writeCompact = (
  data: Data,
  trees?: Map<string, DataTree>,
): string => port.writeCompact(toPort(data), maybeTrees(trees))

// one compact line per top-level form, the way a stream is written
export const writeLines = (
  data: Data,
  trees?: Map<string, DataTree>,
): string => port.writeLines(toPort(data), maybeTrees(trees))

// a value written as the inside of a text literal, read back as itself by `unescape-text` (compile/surface.tree)
export const escapeText = (value: string): string =>
  port.escapeText(value)

// JSON: keys snake there unless `keep`, a whole number past 2^53 as its text (compile/host-data-json.tree)
export const toJson = (data: Data, keep = false): string =>
  json.hostJson(toPort(data), keep)

export const toJsonValue = (data: Data, keep = false): unknown =>
  json.hostJsonValue(toPort(data), keep)

export const fromJson = (text: string): Data =>
  fromPort(json.hostFromJson(text))

export const fromJsonValue = (value: unknown): Data =>
  fromPort(json.hostFromJsonValue(value))

// kebab in the file, snake at the JSON boundary. A key that is not a name is left alone, both ways
export const snake = (key: string): string => port.hostSnake(key)

export const kebab = (key: string): string => port.hostKebab(key)

// every top-level form written compact (`h(`, `l(`, `m(`, `t(`, `f(`): formatted one form per line
export const isCompactTree = (tree: RootNode): boolean =>
  port.isCompactTree(tree as never)

// the canonical form straight from the tree, comments kept: what `writeLong` (or `writeCompact` for a compact file)
// gives a file with no comments. Only on a tree `readData` accepted: it lays out, it does not check
export const formatData = (tree: RootNode, file: string): string =>
  port.formatData(tree as never, file)

// a compact stream, one form per line, a `t(` line declaring an anchor for every line after it
// (note/project/term/host/07-streaming.md)
export function readStream(source: {
  file: string
  text: string
}):
  | { ok: true; data: Data; lines: number }
  | { ok: false; diagnostics: Diagnostic[] } {
  const read = port.readStream(source)

  return read.ok
    ? { ok: true, data: fromPort(read.value), lines: read.lines }
    : { ok: false, diagnostics: read.diagnostics }
}

export type DataKey = { path: string; kind: string; value: string }

// every key of a value as a flat list, a path per row: `x/y/z number 123`. What `term look` prints for a data file
export const dataKeys = (data: Data): DataKey[] =>
  port.dataKeys(toPort(data))

// the source text of a name or a text, unescaped
export const literalText = (node: NameNode | TextNode): string =>
  port.literalText(node as never)
