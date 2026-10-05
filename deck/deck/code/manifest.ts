import fsp from 'fs/promises'
import path from 'path'
import {
  DeckManifest,
  DeckLink,
  DeckMind,
  DeckHostGroup,
  DeckBase,
  CodeHold,
} from './form'
import { parseCode, parseCodeHold, showCode } from './code'
import { scopeName } from './name'
import { parseManifestMill } from './mill'
import { parse, renderHead } from '@term/make/code/parser/tree'
import type { GroupNode, Node } from '@term/make/code/parser/tree'
import { spanOfNode } from '@term/make/code/compile/mill-run'
import {
  readTree,
  formOf,
  formsWith,
  valueOf,
  termOf,
  deepValueOf,
  phraseOf,
} from './read'
import type { Form } from './read'

// The manifest of the project in `dir`.
//
// A missing one is the ORDINARY case of running a package command outside a project, so it is answered with a
// sentence rather than by letting Node's ENOENT out. Five verbs (`host`, `load`, `note`, `save`, `toss`) all reach
// the manifest through here, and every one of them used to print
//
//   ENOENT: no such file or directory, open '/private/var/folders/8x/z26.../T/tmp.pQBAV0ypyb/deck.tree'
//
// which names an absolute path on the machine it ran on, says nothing about what to do, and reads as a crash rather
// than as "you are not in a Term project". term-cli-0005.
export async function loadManifest(input: {
  dir: string
}): Promise<DeckManifest> {
  const file = path.join(input.dir, 'deck.tree')

  let text: string

  try {
    text = await fsp.readFile(file, 'utf-8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      throw new Error(
        'no deck.tree here, so this is not a Term project. Run `term wake <name>` to start one, or change to a directory that has one.',
      )
    }

    throw error
  }

  return parseManifest({ text })
}

export function parseManifest(input: { text: string }): DeckManifest {
  // the manifest reads THROUGH THE MILL (mill-self-hosting-0005): the deck grammar run by the executor. The
  // extraction below over the flattened tree is RETIRED as the primary path and kept only as the reference the
  // differential in test/compile/mill-run.ts holds the grammar against.
  return parseManifestMill(input)
}

export function parseManifestByHand(input: { text: string }): DeckManifest {
  const result = readTree({ file: 'deck.tree', text: input.text })

  if (!result.ok) {
    const first = result.diagnostics[0]

    throw new Error(
      `deck.tree could not be parsed${first ? `: ${first.message}` : ''}`,
    )
  }

  // the whole manifest is one `deck` form; every declaration hangs off it
  const root = result.forms.find(f => f.head === 'deck')

  if (!root) {
    throw new Error('deck.tree has no `deck` declaration')
  }

  // `deck @scope/name`, or a bare `deck name` for an unscoped package
  let host = ''
  let name = root.terms[0] ?? ''
  const slash = name.indexOf('/')

  if (name.startsWith('@') && slash !== -1) {
    host = name.slice(1, slash)
    name = name.slice(slash + 1)
  }

  // `mark <1.4.2>` is the version, `code <1.4.2>` its old spelling; `code ./src` is the code root, `bear ./src` its
  // old spelling. A text value is a version and a path value is a folder
  const mark = parseCode(valueOf(root, 'mark') ?? valueOf(root, 'code') ?? '0.0.0')
  const head = valueOf(root, 'head')

  const mind = formsWith(root, 'mind').map(toMind)

  // `lock mit` and `sort tool` carry a bare word, but tolerate `<...>` too
  const lock = termOf(root, 'lock') ?? valueOf(root, 'lock')
  const sort = termOf(root, 'sort') ?? valueOf(root, 'sort')

  const term = formsWith(root, 'term').map(
    f => f.value ?? f.terms[0] ?? '',
  )

  // a nested `deck ./path` is a member package
  const deck = formsWith(root, 'deck')
    .map(f => f.terms[0] ?? '')
    .filter(Boolean)

  const link = formsWith(root, 'link')
    .map(toLink)
    .filter((l): l is DeckLink => l !== undefined)

  // `case work` holds the dev dependencies, as `link` forms and `host` groups
  const work = formOf(root, 'case')
  const devLink = work
    ? formsWith(work, 'link')
        .map(toLink)
        .filter((l): l is DeckLink => l !== undefined)
    : []

  const hostLink = [
    ...formsWith(root, 'host').map(toHostGroup),
    ...(work ? formsWith(work, 'host').map(toHostGroup) : []),
  ]

  // `base alice, <ghcr.io/alice-gh/term>`
  const base = formsWith(root, 'base').map(
    (f): DeckBase => ({
      scope: scopeName(f.terms[0] ?? ''),
      registry: f.value ?? '',
    }),
  )

  // `hook <name>, task <task>`
  const hook: Record<string, string> = {}

  for (const form of formsWith(root, 'hook')) {
    const hookName = form.terms[0]
    const taskForm = formOf(form, 'task')
    const hookTask = taskForm ? phraseOf(taskForm) : form.terms[1]

    if (hookName && hookTask) {
      hook[hookName] = hookTask
    }
  }

  // `make <security>` is repeatable, and `cite` has the same shape as `mind`
  const make = formsWith(root, 'make')
    .map(f => f.value ?? f.terms[0] ?? '')
    .filter(Boolean)

  const cite = formsWith(root, 'cite').map(toMind)

  // `need @term/code, mark <2.6.x>`: the toolchain, at most one
  const needForm = formOf(root, 'need')
  const needName = needForm?.terms[0]
  const needMark = needForm ? valueOf(needForm, 'mark') : undefined

  const dir = (h: string): string | undefined => termOf(root, h)

  return {
    host,
    name,
    mark,
    code: dir('code') ?? dir('bear'),
    head,
    mind: mind.length > 0 ? mind : undefined,
    lock,
    sort,
    term: term.length > 0 ? term : undefined,
    link,
    hook: Object.keys(hook).length > 0 ? hook : undefined,
    role: dir('role'),
    test: dir('test'),
    book: dir('book'),
    line: dir('line'),
    call: dir('call'),
    task: dir('task'),
    hide: formOf(root, 'hide')
      ? termOf(root, 'hide') === 'true'
      : undefined,
    site: valueOf(root, 'site') ?? termOf(root, 'site'),
    view: termOf(root, 'view') ?? valueOf(root, 'view'),
    deck: deck.length > 0 ? deck : undefined,
    devLink: devLink.length > 0 ? devLink : undefined,
    hostLink: hostLink.length > 0 ? hostLink : undefined,
    base: base.length > 0 ? base : undefined,
    // the fields the grammar knows that this reader used to walk past. Anything read here has to be written back
    // in writeManifest, or the round trip deletes it. See the note on DeckManifest.
    boot: dir('boot'),
    tool: dir('tool'),
    text: valueOf(root, 'text'),
    make: make.length > 0 ? make : undefined,
    cite: cite.length > 0 ? cite : undefined,
    need: needName && needMark ? { name: needName, mark: parseCodeHold(needMark) } : undefined,
  }
}

// `mind <Name>, base <email>, site <url>`, with the same fields also accepted as
// indented children. Both arrive as nested forms, so one path reads both.
function toMind(form: Form): DeckMind {
  const entry: DeckMind = {
    name: form.value ?? form.terms[0] ?? '',
  }

  const base = valueOf(form, 'base')
  const site = valueOf(form, 'site')

  if (base !== undefined) {
    entry.base = base
  }

  if (site !== undefined) {
    entry.site = site
  }

  return entry
}

// `link @scope/name, mark <hold>, have <n>`, or the old `code <hold>`
function toLink(form: Form): DeckLink | undefined {
  const linkName = form.terms[0]

  if (!linkName) {
    return undefined
  }

  const hold = valueOf(form, 'mark') ?? valueOf(form, 'code')
  const have = deepValueOf(form, 'have')
  const parsed = have === undefined ? undefined : Number.parseInt(have, 10)

  return {
    name: linkName,
    mark: hold ? parseCodeHold(hold) : { form: 'wild', major: 0 },
    have: parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined,
  }
}

// `host <registry>` with `link` children: dependencies pinned to one registry
function toHostGroup(form: Form): DeckHostGroup {
  return {
    registry: form.value ?? form.terms[0] ?? '',
    link: formsWith(form, 'link')
      .map(toLink)
      .filter((l): l is DeckLink => l !== undefined),
  }
}





export function writeManifest(input: {
  manifest: DeckManifest
}): string {
  const lines: string[] = []
  const m = input.manifest

  const fullName = m.host ? `@${m.host}/${m.name}` : m.name
  lines.push(`deck ${fullName}`)
  lines.push(`  mark <${showCode(m.mark)}>`)

  // the code root, only when it is not the default: almost no manifest writes it
  if (m.code && !isDefaultCodeRoot(m.code)) {
    lines.push(`  code ${m.code}`)
  }

  if (m.head) {
    lines.push(`  head <${m.head}>`)
  }

  if (m.text) {
    lines.push(`  text <${m.text}>`)
  }

  if (m.hide) {
    lines.push(`  hide true`)
  }

  if (m.lock) {
    lines.push(`  lock ${m.lock}`)
  }

  if (m.sort) {
    lines.push(`  sort <${m.sort}>`)
  }

  if (m.site) {
    lines.push(`  site <${m.site}>`)
  }

  if (m.view) {
    lines.push(`  view ${m.view}`)
  }

  if (m.term) {
    for (const t of m.term) {
      lines.push(`  term <${t}>`)
    }
  }

  if (m.make) {
    for (const k of m.make) {
      lines.push(`  make <${k}>`)
    }
  }

  if (m.deck) {
    for (const d of m.deck) {
      lines.push(`  deck ${d}`)
    }
  }

  for (const entry of m.base ?? []) {
    lines.push(`  base ${entry.scope.replace(/^@/, '')}, <${entry.registry}>`)
  }

  if (m.need) {
    lines.push(`  need ${m.need.name}, mark <${writeCodeHold({ hold: m.need.mark })}>`)
  }

  for (const dep of m.link) {
    const codeStr = writeCodeHold({ hold: dep.mark })

    let line = `  link ${dep.name}, mark <${codeStr}>`

    // A literal opens no level, so under the comma rule `mark <1.x.x>, have 1` would put `have` under `mark`.
    // Parenthesized, `mark` closes first and `have` stays a sibling of it under `link`.
    if (dep.have !== undefined) {
      line = `  link ${dep.name}, mark(<${codeStr}>), have ${dep.have}`
    }

    lines.push(line)
  }

  if (m.hostLink) {
    for (const group of m.hostLink) {
      lines.push(`  host <${group.registry}>`)

      for (const dep of group.link) {
        const codeStr = writeCodeHold({ hold: dep.mark })
        lines.push(`    link ${dep.name}, mark <${codeStr}>`)
      }
    }
  }

  if (m.devLink && m.devLink.length > 0) {
    lines.push(`  case work`)

    for (const dep of m.devLink) {
      const codeStr = writeCodeHold({ hold: dep.mark })
      lines.push(`    link ${dep.name}, mark <${codeStr}>`)
    }
  }

  if (m.task) {
    lines.push(`  task ${m.task}`)
  }

  if (m.book) {
    lines.push(`  book ${m.book}`)
  }

  if (m.role) {
    lines.push(`  role ${m.role}`)
  }

  if (m.line) {
    lines.push(`  line ${m.line}`)
  }

  if (m.call) {
    lines.push(`  call ${m.call}`)
  }

  if (m.test) {
    lines.push(`  test ${m.test}`)
  }

  if (m.boot) {
    lines.push(`  boot ${m.boot}`)
  }

  if (m.tool) {
    lines.push(`  tool ${m.tool}`)
  }

  if (m.mind) {
    for (const f of m.mind) {
      let mindLine = `  mind <${f.name}>`

      if (f.base) {
        mindLine += `, base <${f.base}>`
      }

      lines.push(mindLine)

      if (f.site) {
        lines.push(`    site <${f.site}>`)
      }
    }
  }

  // `cite` is `mind`'s shape under another head: attribution rather than authorship
  if (m.cite) {
    for (const f of m.cite) {
      let citeLine = `  cite <${f.name}>`

      if (f.base) {
        citeLine += `, base <${f.base}>`
      }

      lines.push(citeLine)

      if (f.site) {
        lines.push(`    site <${f.site}>`)
      }
    }
  }

  if (m.hook) {
    for (const [hookName, hookTask] of Object.entries(m.hook)) {
      lines.push(`  hook ${hookName}, task ${hookTask}`)
    }
  }

  return lines.join('\n') + '\n'
}

export function writeCodeHold(input: { hold: CodeHold }): string {
  switch (input.hold.form) {
    case 'exact':
      return showCode(input.hold.code)

    case 'wild': {
      const minor =
        input.hold.minor !== undefined ? `${input.hold.minor}` : 'x'

      const patch =
        input.hold.patch !== undefined ? `${input.hold.patch}` : 'x'

      return `${input.hold.major}.${minor}.${patch}`
    }

    case 'band':
      return `${showCode(input.hold.base)}..${showCode(input.hold.head)}`
    case 'test':
      return input.hold.list
        .map(w => writeCodeHold({ hold: w }))
        .join('|')
  }
}

// Publish rules: a name, and a version that is not 0.0.0. Which patch numbers an author publishes is their own
// convention, so the toolchain does not hold one.
export async function validateManifest(input: {
  manifest: DeckManifest
}): Promise<string[]> {
  const errors: string[] = []

  if (!input.manifest.name) {
    errors.push('Missing package name')
  }

  if (
    input.manifest.mark.major === 0 &&
    input.manifest.mark.minor === 0 &&
    input.manifest.mark.patch === 0
  ) {
    errors.push('Version must be set (not 0.0.0)')
  }

  return errors
}

// `code ./code` is the default, written or not
export function isDefaultCodeRoot(code: string): boolean {
  return code.replace(/^\.\//, '').replace(/\/+$/, '') === 'code'
}

// ---- the old spellings (note/term/plan/manifest-mark-and-code-root.md) ----
//
// The manifest's version was `code <1.4.2>` and is `mark <1.4.2>`, because `code` names the code root folder now.
// A dependency's constraint follows it (`link @x/y, mark <0.0.x>`), and `bear ./code`, which named the same folder
// as `code ./code` and was read by nothing that resolves a path, is that field's old spelling.
//
// The old spellings are told apart by FORM, never by guessing: `code <1.4.2>` carries a text literal and
// `code ./code` a path. A manifest still carrying them reads correctly; `term lint` reports each one and
// `term lint --fix` rewrites it with the edits below, which touch only the one word or the one line, so a comment,
// a blank line or a field order is never disturbed.

export type ManifestSpelling = {
  rule: 'manifest-code-version' | 'manifest-bear'
  message: string
  // zero-based, as the parser's spans are
  line: number
  column: number
  end: number
  // the replacement for [column, end) on `line`. A `bear ./code` (the default, so nothing replaces it) removes its
  // whole line, which `wholeLine` says
  text: string
  wholeLine?: boolean
}

export function manifestSpellings(input: { text: string; file?: string }): ManifestSpelling[] {
  const parsed = parse({ file: input.file ?? 'deck.tree', text: input.text })

  if (!parsed.ok) {
    return []
  }

  const out: ManifestSpelling[] = []
  const headOf = (node: Node | undefined): string | undefined => {
    const first = node?.kind === 'group' ? node.nodes[0] : undefined

    return first?.kind === 'name' ? renderHead(first) : undefined
  }

  // the word itself: the head of `group`, its span in the source
  const wordAt = (group: GroupNode): { line: number; column: number; end: number } | undefined => {
    const span = spanOfNode(group.nodes[0]!)

    return span ? { line: span.start.line, column: span.start.column, end: span.end.column } : undefined
  }

  // `code <...>` with a TEXT argument: the old version spelling, under `deck` or under a `link`
  const oldCode = (group: GroupNode, where: 'version' | 'constraint'): void => {
    if (headOf(group) !== 'code' || group.nodes[1]?.kind !== 'text') {
      return
    }

    const at = wordAt(group)

    if (at) {
      out.push({
        rule: 'manifest-code-version',
        message:
          where === 'version'
            ? '`code <version>` is the old spelling of the version: write `mark <version>`. `code` names the code root folder now'
            : '`link ..., code <range>` is the old spelling of a dependency\'s versions: write `mark <range>`',
        ...at,
        text: 'mark',
      })
    }
  }

  // every group a `link` carries its constraint in: the comma makes `code <...>` a child of the path, and a
  // stacked one is a child of the `link` itself
  const visitLink = (group: GroupNode): void => {
    for (const child of group.nodes.slice(1)) {
      if (child.kind !== 'group') {
        continue
      }

      oldCode(child, 'constraint')
      visitLink(child)
    }
  }

  const visitFields = (group: GroupNode): void => {
    for (const child of group.nodes.slice(1)) {
      if (child.kind !== 'group') {
        continue
      }

      const head = headOf(child)

      if (head === 'code') {
        oldCode(child, 'version')
      } else if (head === 'link') {
        visitLink(child)
      } else if (head === 'host' || head === 'case') {
        visitFields(child)
      } else if (head === 'bear') {
        const value = headOf(child.nodes[1])
        const at = wordAt(child)

        if (value !== undefined && at) {
          out.push(
            isDefaultCodeRoot(value)
              ? {
                  rule: 'manifest-bear',
                  message: '`bear ./code` is the old spelling of `code ./code`, which is the default: the line can go',
                  ...at,
                  text: '',
                  wholeLine: true,
                }
              : {
                  rule: 'manifest-bear',
                  message: `\`bear ${value}\` is the old spelling of the code root: write \`code ${value}\``,
                  ...at,
                  text: 'code',
                },
          )
        }
      }
    }
  }

  // a LOCKFILE is not a manifest: its `deck` entries carry `code <version>` as their own format, which is the
  // package manager's to change and not this rule's
  if (parsed.tree.nodes.some(statement => headOf(statement) === 'lock' && statement.nodes[1]?.kind === 'text')) {
    return []
  }

  for (const statement of parsed.tree.nodes) {
    const head = headOf(statement)

    if (head === 'deck') {
      visitFields(statement)
    } else if (head === 'load') {
      // an app manifest's top-level `load @term/site` with its constraint under it (deck/site/test/site/deck.tree)
      visitLink(statement)
    }
  }

  return out
}

// the manifest text with every old spelling rewritten. Pure: the caller decides whether to write it.
export function rewriteManifestSpellings(input: { text: string; file?: string }): {
  text: string
  changes: ManifestSpelling[]
} {
  const changes = manifestSpellings(input)

  if (changes.length === 0) {
    return { text: input.text, changes }
  }

  const lines = input.text.split('\n')
  const drop = new Set<number>()

  // right to left within a line, so an earlier column stays valid
  const ordered = [...changes].sort((a, b) => b.line - a.line || b.column - a.column)

  for (const change of ordered) {
    if (change.wholeLine) {
      drop.add(change.line)
      continue
    }

    const row = lines[change.line] ?? ''
    lines[change.line] = row.slice(0, change.column) + change.text + row.slice(change.end)
  }

  return { text: lines.filter((_, i) => !drop.has(i)).join('\n'), changes }
}
