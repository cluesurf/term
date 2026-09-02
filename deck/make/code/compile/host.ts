// Term data: the `host` dialect. Tree syntax with five heads (`host`, `list`, `mesh`, `tree`, `fuse`) and six
// literals, no code. This module is the compiler's reader and writer for it: it recognises a data file, walks the
// parser's tree into a `Data` value with every rule of the grammar reported as a diagnostic, expands anchors,
// writes the long and the compact spelling, and converts to and from JSON with key case changed at that boundary
// and nowhere else. `term make`, `term mold` and the tests all go through here, and `@term/host` (the Term-side
// package) is checked against it. See note/term/host/. Pure and browser-safe.

import { parse } from '@term/make/code/parser/tree'
import type {
  GroupNode,
  RootNode,
  TextNode,
  NameNode,
} from '@term/make/code/parser/tree'
import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'

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

type Node = GroupNode['nodes'][number]

const HEADS = new Map<string, string>([
  ['host', 'host'],
  ['list', 'list'],
  ['mesh', 'mesh'],
  ['tree', 'tree'],
  ['fuse', 'fuse'],
  ['h', 'host'],
  ['l', 'list'],
  ['m', 'mesh'],
  ['t', 'tree'],
  ['f', 'fuse'],
])

const KEY = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

// ---- recognising a data file ----

// a `.tree` whose top-level heads are all data heads, and in which no `host` carries a `code` or `text` head (a
// code file of constants writes `host x, code 10`; data writes `host x, 10`)
export function isDataFile(source: { file: string; text: string }): boolean {
  const parsed = parse(source)

  return parsed.ok && isDataTree(parsed.tree)
}

// the same question of a tree already parsed (the editor path parses once)
export function isDataTree(tree: RootNode): boolean {
  if (tree.nodes.length === 0) {
    return false
  }

  for (const group of tree.nodes) {
    const head = headOf(group)

    if (!head || !HEADS.has(head)) {
      return false
    }

    if (carriesCode(group)) {
      return false
    }
  }

  return true
}

// anything under a data head that is not itself a data head, a literal word or a literal is code: `host x` with a
// `take` beneath it is a mixin, `host x, code 10` a constant, `host x, call f` a computed value
function carriesCode(group: GroupNode): boolean {
  for (const node of group.nodes.slice(1)) {
    if (node.kind !== 'group') {
      continue
    }

    const head = headOf(node)

    if (head === undefined) {
      continue
    }

    // a group of one bare name is a key or a literal word (`x`, `true`, or a misspelt value the reader will name)
    const bare = node.nodes.length === 1 && node.nodes[0]?.kind === 'name'

    if (bare) {
      continue
    }

    if (!HEADS.has(head)) {
      return true
    }

    if (carriesCode(node)) {
      return true
    }
  }

  return false
}

// ---- the tree, read ----

export function readDataText(source: {
  file: string
  text: string
}): { ok: true; data: DataFile } | { ok: false; diagnostics: Diagnostic[] } {
  const parsed = parse(source)

  if (!parsed.ok) {
    return { ok: false, diagnostics: parsed.diagnostics }
  }

  return readData(parsed.tree, source.file)
}

export function readData(
  tree: RootNode,
  file: string,
): { ok: true; data: DataFile } | { ok: false; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const trees = new Map<string, DataTree>()

  const error = (span: Span, message: string): void => {
    diagnostics.push(diagnose('syntax-error', { file, span, message }))
  }

  const entries: DataEntry[] = []
  const items: Data[] = []
  let seenData = false

  for (const group of tree.nodes) {
    const head = headOf(group)
    const kind = head ? HEADS.get(head) : undefined

    if (!kind) {
      error(
        spanOf(group),
        `"${head ?? '?'}" is not data. A data file has host, list, mesh, tree and fuse, and nothing else`,
      )
      continue
    }

    switch (kind) {
      case 'tree': {
        if (seenData) {
          error(spanOf(group), `"${keyOf(group) ?? '?'}" is declared after data. Anchors come first`)
        }

        const anchor = readTree(group)

        if (anchor) {
          if (trees.has(anchor.name)) {
            error(spanOf(group), `"${anchor.name}" is declared twice`)
          }

          trees.set(anchor.name, anchor)
        }

        break
      }
      case 'mesh':
        seenData = true
        items.push(readMesh(group))
        break
      case 'fuse':
        seenData = true
        entries.push({ name: '', base: { kind: 'fuse', name: keyOf(group) ?? '' } })
        break
      default: {
        seenData = true
        const entry = readEntry(group, kind)

        if (entry) {
          entries.push(entry)
        }
      }
    }
  }

  if (entries.length > 0 && items.length > 0) {
    error(
      spanOf(tree.nodes[0]!),
      'a file is a map of "host" entries or a list of "mesh" items, never both',
    )
  }

  const root: Data =
    items.length > 0 ? { kind: 'list', list: items } : { kind: 'hash', list: entries }

  checkKeys(root, error)

  if (diagnostics.length) {
    return { ok: false, diagnostics }
  }

  return { ok: true, data: { root, trees } }

  // `host <key>, <scalar>` / `host <key>` + entries / `list <key>` + items
  function readEntry(group: GroupNode, kind: string): DataEntry | undefined {
    const name = keyOf(group)
    const keyNode = group.nodes[1]

    if (name === undefined) {
      if (kind === 'list') {
        error(spanOf(group), 'a "list" at this level needs a key. A nested list without one sits inside a list')
      } else {
        error(spanOf(group), '"host" needs a key')
      }

      return undefined
    }

    if (!KEY.test(name) && keyNode?.kind !== 'text') {
      error(
        spanOf(group),
        `"${name}" is not a key. A key is a name: letters, digits and dashes, starting with a letter`,
      )

      return undefined
    }

    const rest = group.nodes.slice(2)

    if (kind === 'host') {
      // a bare `true` / `false` / `void` after the comma parses as a group of one name, so it is a scalar, not a block
      const scalars = rest.filter(n => isScalar(n))
      const blocks = rest.filter(n => n.kind === 'group' && !isScalar(n))

      if (scalars.length > 0 && blocks.length > 0) {
        error(spanOf(group), `"${name}" has a value and children. A scalar entry has one, a map entry has the other`)

        return undefined
      }

      if (scalars.length > 1) {
        error(spanOf(group), `"${name}" has ${scalars.length} values. A list is written "list ${name}"`)

        return undefined
      }

      if (scalars.length === 1) {
        return { name, base: readScalar(scalars[0]!) }
      }

      return { name, base: { kind: 'hash', list: readEntries(blocks as GroupNode[], name) } }
    }

    return { name, base: { kind: 'list', list: readItems(rest, name) } }
  }

  // the entries of a map block
  function readEntries(groups: GroupNode[], owner: string): DataEntry[] {
    const out: DataEntry[] = []

    for (const child of groups) {
      const head = headOf(child)
      const kind = head ? HEADS.get(head) : undefined

      if (kind === 'host' || kind === 'list') {
        const entry = readEntry(child, kind)

        if (entry) {
          out.push(entry)
        }
      } else if (kind === 'fuse') {
        out.push({ name: '', base: { kind: 'fuse', name: keyOf(child) ?? '' } })
      } else if (kind === 'mesh') {
        error(spanOf(child), `"mesh" is a list item and "${owner}" is a map. Give it a key with "host"`)
      } else if (kind === 'tree') {
        error(spanOf(child), `"${keyOf(child) ?? '?'}" is declared inside "${owner}". Anchors come first, at the top`)
      } else if (child.nodes.length === 1 && head) {
        // a bare word where a value belongs: `host env, prod`
        error(spanOf(child), `"${head}" is not a value. Text is written <${head}>`)
      } else {
        error(
          spanOf(child),
          `"${head ?? '?'}" is not data. A data file has host, list, mesh, tree and fuse, and nothing else`,
        )
      }
    }

    return out
  }

  // the items of a list: scalars, `mesh` maps, nested `list`s, `fuse`s
  function readItems(nodes: Node[], owner: string): Data[] {
    const out: Data[] = []

    for (const node of nodes) {
      if (isScalar(node)) {
        out.push(readScalar(node))
        continue
      }

      if (node.kind !== 'group') {
        continue
      }

      const head = headOf(node)
      const kind = head ? HEADS.get(head) : undefined

      if (kind === 'mesh') {
        out.push(readMesh(node))
      } else if (kind === 'list') {
        if (keyOf(node) !== undefined && bareKey(node) && !isScalarWord(bareKey(node)!)) {
          error(spanOf(node), `"${keyOf(node)}" is a keyed list inside the list "${owner}". A nested list has no key`)
        } else {
          out.push({ kind: 'list', list: readItems(node.nodes.slice(1), owner) })
        }
      } else if (kind === 'fuse') {
        out.push({ kind: 'fuse', name: keyOf(node) ?? '' })
      } else if (kind === 'host') {
        error(
          spanOf(node),
          `"${owner}" is a list, so its items are scalars, "mesh" maps or "list" lists, never "host" entries`,
        )
      } else if (isScalarWord(node.nodes[0]!) && node.nodes.length === 1) {
        out.push(readScalar(node.nodes[0]!))
      } else {
        error(spanOf(node), `"${head ?? '?'}" is not a value. Text is written <${head ?? ''}>`)
      }
    }

    return out
  }

  function readMesh(group: GroupNode): Data {
    const rest = group.nodes.slice(1)
    const first = rest[0]

    if (first && first.kind !== 'group') {
      error(spanOf(group), '"mesh" takes no key. Its items are the "host" lines beneath it')
    }

    return {
      kind: 'hash',
      list: readEntries(
        rest.filter((n): n is GroupNode => n.kind === 'group' && !isScalar(n)),
        'mesh',
      ),
    }
  }

  function readTree(group: GroupNode): DataTree | undefined {
    const name = keyOf(group)

    if (name === undefined || !KEY.test(name)) {
      error(spanOf(group), '"tree" needs a name')

      return undefined
    }

    const rest = group.nodes.slice(2)
    const first = rest.find(n => n.kind === 'group' || isScalar(n))

    if (!first) {
      return { name, hold: 'hash', list: [] }
    }

    const firstKind =
      first.kind === 'group' ? HEADS.get(headOf(first) ?? '') : 'scalar'

    if (firstKind === 'host' || firstKind === 'list' || firstKind === 'fuse') {
      return {
        name,
        hold: 'hash',
        list: readEntries(
          rest.filter((n): n is GroupNode => n.kind === 'group' && !isScalar(n)),
          name,
        ),
      }
    }

    return { name, hold: 'list', list: readItems(rest, name) }
  }

  // a key given twice in one map, with no `fuse` between, is an error
  function checkKeys(data: Data, report: (span: Span, message: string) => void): void {
    if (data.kind === 'hash') {
      const seen = new Set<string>()

      for (const entry of data.list) {
        if (entry.base.kind === 'fuse') {
          seen.clear()
          continue
        }

        if (seen.has(entry.name)) {
          report(spanOf(tree.nodes[0]!), `"${entry.name}" is given twice`)
        }

        seen.add(entry.name)
        checkKeys(entry.base, report)
      }
    } else if (data.kind === 'list') {
      for (const item of data.list) {
        checkKeys(item, report)
      }
    }
  }
}

// ---- anchors ----

export function expandData(
  data: DataFile,
  file = 'data.tree',
): { ok: true; data: Data } | { ok: false; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const ZERO: Span = { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } }
  const error = (message: string): void => {
    diagnostics.push(diagnose('syntax-error', { file, span: ZERO, message }))
  }

  const expanding: string[] = []

  const expandEntries = (list: DataEntry[]): DataEntry[] => {
    const out: DataEntry[] = []

    for (const entry of list) {
      if (entry.base.kind === 'fuse') {
        const anchor = data.trees.get(entry.base.name)

        if (!anchor) {
          error(`"${entry.base.name}" is fused but no tree declares it`)
          continue
        }

        if (anchor.hold !== 'hash') {
          error(`"${entry.base.name}" holds list items and is fused into a map`)
          continue
        }

        if (expanding.includes(anchor.name)) {
          error(`"${anchor.name}" fuses itself through ${[...expanding, anchor.name].join(', ')}`)
          continue
        }

        expanding.push(anchor.name)
        const fused = expandEntries(anchor.list as DataEntry[])
        expanding.pop()

        for (const f of fused) {
          replace(out, f)
        }

        continue
      }

      replace(out, { name: entry.name, base: expand(entry.base) })
    }

    return out
  }

  // later wins: an entry with a key already present replaces it in place
  const replace = (out: DataEntry[], entry: DataEntry): void => {
    const at = out.findIndex(e => e.name === entry.name)

    if (at >= 0) {
      out[at] = entry
    } else {
      out.push(entry)
    }
  }

  const expandItems = (list: Data[]): Data[] => {
    const out: Data[] = []

    for (const item of list) {
      if (item.kind === 'fuse') {
        const anchor = data.trees.get(item.name)

        if (!anchor) {
          error(`"${item.name}" is fused but no tree declares it`)
          continue
        }

        if (anchor.hold !== 'list') {
          error(`"${item.name}" holds map entries and is fused into a list`)
          continue
        }

        if (expanding.includes(anchor.name)) {
          error(`"${anchor.name}" fuses itself through ${[...expanding, anchor.name].join(', ')}`)
          continue
        }

        expanding.push(anchor.name)
        out.push(...expandItems(anchor.list as Data[]))
        expanding.pop()
        continue
      }

      out.push(expand(item))
    }

    return out
  }

  const expand = (value: Data): Data => {
    switch (value.kind) {
      case 'hash':
        return { kind: 'hash', list: expandEntries(value.list) }
      case 'list':
        return { kind: 'list', list: expandItems(value.list) }
      case 'fuse':
        error(`"${value.name}" is fused where a value belongs`)

        return { kind: 'void' }
      default:
        return value
    }
  }

  const root = expand(data.root)

  return diagnostics.length ? { ok: false, diagnostics } : { ok: true, data: root }
}

// ---- writing ----

const WIDTH = 78

export function writeLong(data: Data, trees?: Map<string, DataTree>): string {
  const lines: string[] = []

  for (const anchor of trees?.values() ?? []) {
    lines.push(`tree ${anchor.name}`)

    if (anchor.hold === 'hash') {
      entries(anchor.list as DataEntry[], 1, lines)
    } else {
      items(anchor.list as Data[], 1, lines)
    }

    lines.push('')
  }

  if (data.kind === 'hash') {
    entries(data.list, 0, lines)
  } else if (data.kind === 'list') {
    items(data.list, 0, lines)
  } else {
    lines.push(scalar(data))
  }

  return lines.join('\n').replace(/\n+$/, '') + '\n'

  function entries(list: DataEntry[], depth: number, out: string[]): void {
    const pad = '  '.repeat(depth)

    for (const entry of list) {
      const key = KEY.test(entry.name) ? entry.name : `<${escapeText(entry.name)}>`
      const value = entry.base

      if (value.kind === 'fuse') {
        out.push(`${pad}fuse ${value.name}`)
      } else if (value.kind === 'hash') {
        out.push(`${pad}host ${key}`)
        entries(value.list, depth + 1, out)
      } else if (value.kind === 'list') {
        out.push(`${pad}list ${key}`)
        items(value.list, depth + 1, out)
      } else {
        out.push(`${pad}host ${key}, ${scalar(value)}`)
      }
    }
  }

  function items(list: Data[], depth: number, out: string[]): void {
    const pad = '  '.repeat(depth)

    // a run of scalars goes on one line, comma separated, wrapped at the width
    if (list.length > 0 && list.every(i => isScalarData(i))) {
      let line = pad

      for (const item of list) {
        const word = scalar(item)

        if (line !== pad && line.length + 2 + word.length > WIDTH) {
          out.push(line)
          line = pad
        }

        line += (line === pad ? '' : ', ') + word
      }

      out.push(line)

      return
    }

    for (const item of list) {
      if (item.kind === 'fuse') {
        out.push(`${pad}fuse ${item.name}`)
      } else if (item.kind === 'hash') {
        out.push(`${pad}mesh`)
        entries(item.list, depth + 1, out)
      } else if (item.kind === 'list') {
        out.push(`${pad}list`)
        items(item.list, depth + 1, out)
      } else {
        out.push(`${pad}${scalar(item)}`)
      }
    }
  }
}

export function writeCompact(data: Data, trees?: Map<string, DataTree>): string {
  const lines: string[] = []

  for (const anchor of trees?.values() ?? []) {
    const body =
      anchor.hold === 'hash'
        ? (anchor.list as DataEntry[]).map(entry)
        : (anchor.list as Data[]).map(item)

    lines.push(`t(${anchor.name}${body.length ? ',' + body.join(',') : ''})`)
  }

  if (data.kind === 'hash') {
    for (const e of data.list) {
      lines.push(entry(e))
    }
  } else if (data.kind === 'list') {
    for (const i of data.list) {
      lines.push(item(i))
    }
  } else {
    lines.push(scalar(data))
  }

  return lines.join('\n') + '\n'

  function entry(e: DataEntry): string {
    const key = KEY.test(e.name) ? e.name : `<${escapeText(e.name)}>`

    switch (e.base.kind) {
      case 'fuse':
        return `f(${e.base.name})`
      case 'hash':
        return `h(${[key, ...e.base.list.map(entry)].join(',')})`
      case 'list':
        return `l(${[key, ...e.base.list.map(item)].join(',')})`
      default:
        return `h(${key},${scalar(e.base)})`
    }
  }

  function item(i: Data): string {
    switch (i.kind) {
      case 'fuse':
        return `f(${i.name})`
      case 'hash':
        return `m(${i.list.map(entry).join(',')})`
      case 'list':
        return `l(${i.list.map(item).join(',')})`
      default:
        return scalar(i)
    }
  }
}

// one compact line per top-level form, the way a stream is written
export function writeLines(data: Data, trees?: Map<string, DataTree>): string {
  return writeCompact(data, trees)
}

function isScalarData(data: Data): boolean {
  return data.kind !== 'hash' && data.kind !== 'list' && data.kind !== 'fuse'
}

function scalar(data: Data): string {
  switch (data.kind) {
    case 'text':
      return `<${escapeText(data.value)}>`
    case 'number':
      return Number.isInteger(data.value) ? String(data.value) : String(data.value)
    case 'decimal':
      return Number.isInteger(data.value) ? `${data.value}.0` : String(data.value)
    case 'flag':
      return data.value ? 'true' : 'false'
    case 'void':
      return 'void'
    default:
      return 'void'
  }
}

function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/</g, '\\<')
    .replace(/>/g, '\\>')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
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
  return KEY.test(key) ? key.replace(/-/g, '_') : key
}

export function kebab(key: string): string {
  return /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(key) ? key.replace(/_/g, '-') : key
}

// ---- formatting a data file, comments kept ----

// is every top-level form written in the compact spelling (`h(`, `l(`, `m(`, `t(`, `f(`)? Such a file is formatted
// one form per line, the way a stream is written
export function isCompactTree(tree: RootNode): boolean {
  return tree.nodes.length > 0 && tree.nodes.every(g => (headOf(g) ?? '').length === 1)
}

// the canonical form straight from the tree, so a comment survives `term form`. Byte for byte what `writeLong`
// (or `writeCompact` for a compact file) gives for the same value when the file carries no comments. Call it only
// on a tree `readData` accepted: it lays out, it does not check.
export function formatData(tree: RootNode, file: string): string {
  if (isCompactTree(tree)) {
    return formatCompact(tree, file)
  }

  const out: string[] = []
  const anchors = tree.nodes.filter(g => HEADS.get(headOf(g) ?? '') === 'tree')
  const rest = tree.nodes.filter(g => HEADS.get(headOf(g) ?? '') !== 'tree')

  for (const group of anchors) {
    notes(group, 0, out)
    out.push(`tree ${keyText(keyOf(group) ?? '')}`)
    body(group.nodes.slice(2), 1, out)
    out.push('')
  }

  body(rest, 0, out)

  return out.join('\n').replace(/\n+$/, '') + '\n'

  // the comments written above a group (or above a line that opens with a literal), at the indent
  function notes(node: Node, depth: number, into: string[]): void {
    if (node.kind === 'name') {
      return
    }

    for (const comment of node.comments ?? []) {
      into.push(`${'  '.repeat(depth)}${comment.text.trim()}`)
    }
  }

  // entries or items, decided by the first child that is one or the other
  function body(nodes: Node[], depth: number, into: string[]): void {
    const first = nodes.find(n => n.kind === 'group' || isScalar(n))

    if (!first) {
      return
    }

    const kind = first.kind === 'group' && !isScalar(first) ? HEADS.get(headOf(first) ?? '') : 'scalar'

    if (kind === 'host' || kind === 'list' || kind === 'fuse') {
      entries(nodes, depth, into)
    } else {
      items(nodes, depth, into)
    }
  }

  function entries(nodes: Node[], depth: number, into: string[]): void {
    const pad = '  '.repeat(depth)

    for (const node of nodes) {
      if (node.kind !== 'group') {
        continue
      }

      notes(node, depth, into)

      const kind = HEADS.get(headOf(node) ?? '')
      const key = keyText(keyOf(node) ?? '')

      if (kind === 'fuse') {
        into.push(`${pad}fuse ${keyOf(node) ?? ''}`)
      } else if (kind === 'host') {
        const value = node.nodes.slice(2).find(n => isScalar(n))

        if (value) {
          into.push(`${pad}host ${key}, ${scalar(readScalar(value))}`)
        } else {
          into.push(`${pad}host ${key}`)
          entries(node.nodes.slice(2), depth + 1, into)
        }
      } else if (kind === 'list') {
        into.push(`${pad}list ${key}`)
        items(node.nodes.slice(2), depth + 1, into)
      }
    }
  }

  function items(nodes: Node[], depth: number, into: string[]): void {
    const pad = '  '.repeat(depth)
    const present = nodes.filter(n => n.kind === 'group' || isScalar(n))

    // a run of scalars goes on one line, comma separated, wrapped at the width. A comment above one of them (a bare
    // `true` on its own line is a group) goes above the run
    if (present.length > 0 && present.every(n => isScalar(n))) {
      for (const node of present) {
        notes(node, depth, into)
      }

      let line = pad

      for (const node of present) {
        const word = scalar(readScalar(node))

        if (line !== pad && line.length + 2 + word.length > WIDTH) {
          into.push(line)
          line = pad
        }

        line += (line === pad ? '' : ', ') + word
      }

      into.push(line)

      return
    }

    for (const node of present) {
      notes(node, depth, into)

      if (isScalar(node)) {
        into.push(`${pad}${scalar(readScalar(node))}`)
        continue
      }

      const group = node as GroupNode
      const kind = HEADS.get(headOf(group) ?? '')

      if (kind === 'fuse') {
        into.push(`${pad}fuse ${keyOf(group) ?? ''}`)
      } else if (kind === 'mesh') {
        into.push(`${pad}mesh`)
        entries(group.nodes.slice(1), depth + 1, into)
      } else if (kind === 'list') {
        into.push(`${pad}list`)
        items(group.nodes.slice(1), depth + 1, into)
      }
    }
  }
}

// a compact file: every top-level form on its own line, comments above it kept
function formatCompact(tree: RootNode, file: string): string {
  const out: string[] = []

  for (const group of tree.nodes) {
    for (const comment of group.comments ?? []) {
      out.push(comment.text.trim())
    }

    const read = readData({ ...tree, nodes: [group] }, file)

    if (read.ok) {
      out.push(writeCompact(read.data.root, read.data.trees).replace(/\n$/, ''))
    }
  }

  return out.join('\n') + '\n'
}

function keyText(name: string): string {
  return KEY.test(name) ? name : `<${escapeText(name)}>`
}

// ---- a stream ----

// a compact stream: one form per line, a `t(` line declaring (or re-declaring) an anchor for every line after it,
// `h(` / `l(` lines the entries of a map or `m(` lines the items of a list, never both. Blank lines and `#` lines
// are skipped. Each line is expanded against the anchors declared so far. See note/term/host/07-streaming.md.
export function readStream(source: {
  file: string
  text: string
}): { ok: true; data: Data; lines: number } | { ok: false; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const trees = new Map<string, DataTree>()
  const entries: DataEntry[] = []
  const items: Data[] = []
  let count = 0

  source.text.split('\n').forEach((line, index) => {
    const trimmed = line.trim()

    if (trimmed === '' || trimmed.startsWith('#')) {
      return
    }

    // the line at its own line number, so a diagnostic points into the stream
    const parsed = parse({ file: source.file, text: '\n'.repeat(index) + line })

    if (!parsed.ok) {
      diagnostics.push(...parsed.diagnostics)

      return
    }

    const read = readData(parsed.tree, source.file)

    if (!read.ok) {
      diagnostics.push(...read.diagnostics)

      return
    }

    for (const anchor of read.data.trees.values()) {
      trees.set(anchor.name, anchor)
    }

    const root = read.data.root

    if (root.kind === 'hash' && root.list.length === 0) {
      return
    }

    count++

    const span = spanOf(parsed.tree.nodes[0]!)

    if ((root.kind === 'hash' && items.length > 0) || (root.kind === 'list' && entries.length > 0)) {
      diagnostics.push(
        diagnose('syntax-error', {
          file: source.file,
          span,
          message: 'a stream is a map of "h(" entries or a list of "m(" items, never both',
        }),
      )

      return
    }

    const expanded = expandData({ root, trees: new Map(trees) }, source.file)

    if (!expanded.ok) {
      diagnostics.push(...expanded.diagnostics)

      return
    }

    if (expanded.data.kind === 'hash') {
      entries.push(...expanded.data.list)
    } else if (expanded.data.kind === 'list') {
      items.push(...expanded.data.list)
    }
  })

  if (diagnostics.length) {
    return { ok: false, diagnostics }
  }

  return {
    ok: true,
    data: items.length > 0 ? { kind: 'list', list: items } : { kind: 'hash', list: entries },
    lines: count,
  }
}

// ---- the keys of a value ----

export type DataKey = { path: string; kind: string; value: string }

// every key of a value as a flat list, a path per row: `x/y/z number 123`. A map or a list row says how many it
// holds. What `term look` prints for a data file.
export function dataKeys(data: Data): DataKey[] {
  const out: DataKey[] = []
  walk(data, '')

  return out

  function walk(value: Data, path: string): void {
    if (value.kind === 'hash') {
      if (path) {
        out.push({ path, kind: 'map', value: `${value.list.length} ${value.list.length === 1 ? 'entry' : 'entries'}` })
      }

      for (const entry of value.list) {
        walk(entry.base, path ? `${path}/${entry.name}` : entry.name)
      }
    } else if (value.kind === 'list') {
      if (path) {
        out.push({ path, kind: 'list', value: `${value.list.length} ${value.list.length === 1 ? 'item' : 'items'}` })
      }

      value.list.forEach((item, at) => walk(item, path ? `${path}/${at}` : String(at)))
    } else if (value.kind === 'fuse') {
      out.push({ path, kind: 'fuse', value: value.name })
    } else {
      out.push({ path: path || '.', kind: value.kind, value: scalar(value) })
    }
  }
}

// a scalar: a literal node, or a bare `true` / `false` / `void` word
function readScalar(node: Node): Data {
  switch (node.kind) {
    case 'integer':
    case 'radix':
      return { kind: 'number', value: node.value }
    case 'decimal':
      return { kind: 'decimal', value: node.value }
    case 'text':
      return { kind: 'text', value: literalText(node) }
    case 'name': {
      const word = literalText(node)

      return word === 'true' || word === 'false'
        ? { kind: 'flag', value: word === 'true' }
        : { kind: 'void' }
    }
    case 'group':
      return readScalar(node.nodes[0]!)
    default:
      return { kind: 'void' }
  }
}

function isScalar(node: Node): boolean {
  if (
    node.kind === 'integer' ||
    node.kind === 'decimal' ||
    node.kind === 'radix' ||
    node.kind === 'text'
  ) {
    return true
  }

  if (node.kind === 'name') {
    return isScalarWord(node)
  }

  // a bare word on its own line parses as a group of one name
  if (node.kind === 'group' && node.nodes.length === 1) {
    const only = node.nodes[0]!

    return only.kind !== 'group' && isScalar(only)
  }

  return false
}

function isScalarWord(node: Node): boolean {
  if (node.kind !== 'name') {
    return false
  }

  const word = literalText(node)

  return word === 'true' || word === 'false' || word === 'void'
}

// ---- tree helpers ----

function headOf(group: GroupNode): string | undefined {
  const head = group.nodes[0]

  return head?.kind === 'name' ? literalText(head) : undefined
}

// the key of `host <key>` / `list <key>` / `tree <name>` / `fuse <name>`: the second node, a name or a text
function keyOf(group: GroupNode): string | undefined {
  const node = group.nodes[1]

  if (node?.kind === 'name' || node?.kind === 'text') {
    return literalText(node)
  }

  if (node?.kind === 'group' && node.nodes.length === 1 && node.nodes[0]?.kind === 'name') {
    return literalText(node.nodes[0])
  }

  return undefined
}

// the key of a group when it is written as a bare word (a name, or the one-name group a word on its own line
// parses as), never when it is a `<text>`
function bareKey(group: GroupNode): NameNode | undefined {
  const node = group.nodes[1]

  if (node?.kind === 'name') {
    return node
  }

  if (node?.kind === 'group' && node.nodes.length === 1 && node.nodes[0]?.kind === 'name') {
    return node.nodes[0]
  }

  return undefined
}

// the source text of a name or a text, unescaped. `{` is a literal brace in data, so an interpolation part is
// put back as the characters it was written with.
export function literalText(node: NameNode | TextNode): string {
  let out = ''

  for (const part of node.parts) {
    if (part.kind === 'chunk') {
      out += part.text
    } else {
      const inner = part.group ? part.group.nodes.map(n => (n.kind === 'name' ? literalText(n) : '')).join('') : ''
      out += `{${inner}}`
    }
  }

  return node.kind === 'text' ? unescapeText(out) : out
}

// The escapes a text literal understands. `<` `>` `{` `}` are the delimiters, so they escape themselves; `\n`
// `\r` `\t` are the usual three.
//
// `\e` IS THE ESCAPE CHARACTER (0x1B), and it was added because without it a Term program cannot write a terminal
// colour. Every ANSI sequence begins with it, so `tint` -- the CLI's colour, and the single most-docked TypeScript
// module in the converted CLI -- could not be written in Term at all: it could only call chalk, which is an npm
// package a native binary cannot have. One escape in the lexer is what lets that module be Term and lets every
// module that uses it emit Rust that builds. It is also what `terminal` support needs on every backend.
function unescapeText(value: string): string {
  return value.replace(/\\([<>{}nrte\\])/g, (_, c: string) => {
    switch (c) {
      case 'n':
        return '\n'
      case 'r':
        return '\r'
      case 't':
        return '\t'
      case 'e':
        return '\u001b'
      default:
        return c
    }
  })
}

function spanOf(node: Node | RootNode): Span {
  const ZERO: Span = { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } }

  switch (node.kind) {
    case 'integer':
    case 'decimal':
    case 'radix':
      return node.token.span
    case 'name':
    case 'text': {
      const chunk = node.parts.find(p => p.kind === 'chunk')

      return chunk?.kind === 'chunk' ? chunk.token.span : ZERO
    }
    case 'group':
      return node.nodes[0] ? spanOf(node.nodes[0]) : ZERO
    default:
      return ZERO
  }
}
