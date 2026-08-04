import fsp from 'fs/promises'
import path from 'path'
import {
  DeckManifest,
  DeckLink,
  DeckMind,
  DeckHostGroup,
  CodeHold,
} from './form'
import { parseCode, parseCodeHold, showCode } from './code'
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

export async function loadManifest(input: {
  dir: string
}): Promise<DeckManifest> {
  const file = path.join(input.dir, 'deck.tree')
  const text = await fsp.readFile(file, 'utf-8')

  return parseManifest({ text })
}

export function parseManifest(input: { text: string }): DeckManifest {
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

  const code = parseCode(valueOf(root, 'code') ?? '0.0.0')
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

  const dir = (h: string): string | undefined => termOf(root, h)

  return {
    host,
    name,
    code,
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

// `link @scope/name, code <hold>, have <n>`
function toLink(form: Form): DeckLink | undefined {
  const linkName = form.terms[0]

  if (!linkName) {
    return undefined
  }

  const hold = valueOf(form, 'code')
  const have = deepValueOf(form, 'have')
  const parsed = have === undefined ? undefined : Number.parseInt(have, 10)

  return {
    name: linkName,
    code: hold ? parseCodeHold(hold) : { form: 'wild', major: 0 },
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
  lines.push(`  code <${showCode(m.code)}>`)

  if (m.head) {
    lines.push(`  head <${m.head}>`)
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

  if (m.deck) {
    for (const d of m.deck) {
      lines.push(`  deck ${d}`)
    }
  }

  for (const dep of m.link) {
    const codeStr = writeCodeHold({ hold: dep.code })

    let line = `  link ${dep.name}, code <${codeStr}>`

    if (dep.have !== undefined) {
      line += `, have ${dep.have}`
    }

    lines.push(line)
  }

  if (m.hostLink) {
    for (const group of m.hostLink) {
      lines.push(`  host <${group.registry}>`)

      for (const dep of group.link) {
        const codeStr = writeCodeHold({ hold: dep.code })
        lines.push(`    link ${dep.name}, code <${codeStr}>`)
      }
    }
  }

  if (m.devLink && m.devLink.length > 0) {
    lines.push(`  case work`)

    for (const dep of m.devLink) {
      const codeStr = writeCodeHold({ hold: dep.code })
      lines.push(`    link ${dep.name}, code <${codeStr}>`)
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

  if (m.hook) {
    for (const [hookName, hookTask] of Object.entries(m.hook)) {
      lines.push(`  hook ${hookName}, task ${hookTask}`)
    }
  }

  return lines.join('\n') + '\n'
}

function writeCodeHold(input: { hold: CodeHold }): string {
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

// Publish rules: a name, a version that is not 0.0.0, and an EVEN patch number.
export async function validateManifest(input: {
  manifest: DeckManifest
}): Promise<string[]> {
  const errors: string[] = []

  if (!input.manifest.name) {
    errors.push('Missing package name')
  }

  if (
    input.manifest.code.major === 0 &&
    input.manifest.code.minor === 0 &&
    input.manifest.code.patch === 0
  ) {
    errors.push('Version must be set (not 0.0.0)')
  }

  if (input.manifest.code.patch % 2 !== 0) {
    errors.push('Published versions must use even patch numbers')
  }

  return errors
}
