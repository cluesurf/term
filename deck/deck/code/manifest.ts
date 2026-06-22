import fsp from 'fs/promises'
import path from 'path'
import {
  DeckManifest,
  DeckLink,
  DeckMind,
  DeckHostGroup,
  MarkHold,
} from './form'
import { parseMark, parseMarkHold, showMark } from './mark'

export async function loadManifest(input: {
  dir: string
}): Promise<DeckManifest> {
  const file = path.join(input.dir, 'deck.tree')
  const text = await fsp.readFile(file, 'utf-8')

  return parseManifest({ text })
}

export function parseManifest(input: { text: string }): DeckManifest {
  const lines = input.text.split('\n')

  let host = ''
  let name = ''
  let mark = { major: 0, minor: 0, patch: 0 }
  let head: string | undefined

  const mind: DeckMind[] = []

  let lock: string | undefined
  let sort: string | undefined

  const term: string[] = []
  const link: DeckLink[] = []
  const hook: Record<string, string> = {}

  let role: string | undefined
  let test: string | undefined
  let bookDir: string | undefined
  let lineDir: string | undefined
  let callDir: string | undefined
  let taskDir: string | undefined
  let hide: boolean | undefined
  let site: string | undefined
  let view: string | undefined

  const deck: string[] = []
  const devLink: DeckLink[] = []
  const hostLink: DeckHostGroup[] = []

  let i = 0

  while (i < lines.length) {
    const raw = lines[i]!
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()
    i++

    if (!line || line.startsWith('#')) {continue}

    if (line.startsWith('deck ')) {
      const deckValue = line.slice(5).trim()

      // Sub-package path (inside indented block)
      if (indent >= 2 && deckValue.startsWith('./')) {
        deck.push(deckValue)
        continue
      }

      // Package name declaration (top-level)
      const parts = deckValue.split('/')

      if (parts.length === 2 && parts[0]!.startsWith('@')) {
        host = parts[0]!.slice(1)
        name = parts[1]!
      } else {
        name = deckValue
      }

      continue
    }

    if (line.startsWith('mark ')) {
      const markText = extractAngle(line.slice(5).trim())
      mark = parseMark(markText)
      continue
    }

    if (line.startsWith('head ')) {
      head = extractAngle(line.slice(5).trim())
      continue
    }

    if (line.startsWith('mind ')) {
      const mindLine = line.slice(5).trim()
      const mindEntry = parseMindLine({ text: mindLine })

      // Check for child lines (site, base)
      while (i < lines.length) {
        const nextRaw = lines[i]!
        const nextIndent = nextRaw.length - nextRaw.trimStart().length
        const nextLine = nextRaw.trim()

        if (!nextLine || nextLine.startsWith('#')) {
          i++
          continue
        }

        if (nextIndent <= indent) {break}

        if (nextLine.startsWith('site ')) {
          mindEntry.site = extractAngle(nextLine.slice(5).trim())
        } else if (nextLine.startsWith('base ')) {
          mindEntry.base = extractAngle(nextLine.slice(5).trim())
        }

        i++
      }

      mind.push(mindEntry)
      continue
    }

    if (line.startsWith('lock ')) {
      lock = line.slice(5).trim()
      continue
    }

    if (line.startsWith('sort ')) {
      sort = extractAngle(line.slice(5).trim())
      continue
    }

    if (line.startsWith('term ')) {
      term.push(extractAngle(line.slice(5).trim()))
      continue
    }

    if (line.startsWith('role ')) {
      role = line.slice(5).trim()
      continue
    }

    if (line.startsWith('test ')) {
      test = line.slice(5).trim()
      continue
    }

    if (line.startsWith('book ')) {
      bookDir = line.slice(5).trim()
      continue
    }

    if (line.startsWith('line ')) {
      lineDir = line.slice(5).trim()
      continue
    }

    if (line.startsWith('call ')) {
      callDir = line.slice(5).trim()
      continue
    }

    if (line.startsWith('task ')) {
      taskDir = line.slice(5).trim()
      continue
    }

    if (line.startsWith('hide ')) {
      hide = line.slice(5).trim() === 'true'
      continue
    }

    if (line.startsWith('site ')) {
      site = extractAngle(line.slice(5).trim())
      continue
    }

    if (line.startsWith('view ')) {
      view = line.slice(5).trim()
      continue
    }

    if (line.startsWith('case work')) {
      // Dev dependencies block. Collect indented children.
      while (i < lines.length) {
        const nextRaw = lines[i]!
        const nextIndent = nextRaw.length - nextRaw.trimStart().length
        const nextLine = nextRaw.trim()

        if (!nextLine || nextLine.startsWith('#')) {
          i++
          continue
        }

        if (nextIndent <= indent) {break}

        if (nextLine.startsWith('link ')) {
          const parsed = parseLinkLine({
            text: nextLine.slice(5).trim(),
          })

          if (parsed) {devLink.push(parsed)}
        } else if (nextLine.startsWith('host ')) {
          const group = parseHostBlock({
            lines,
            index: i - 1,
            parentIndent: nextIndent,
          })

          hostLink.push(group.group)
          // The host block parser consumed lines up to group.nextIndex
          // but we need to adjust since our outer loop increments i
          i = group.nextIndex
          continue
        }

        i++
      }

      continue
    }

    if (line.startsWith('host ')) {
      const group = parseHostBlock({
        lines,
        index: i - 1,
        parentIndent: indent,
      })

      hostLink.push(group.group)
      i = group.nextIndex
      continue
    }

    if (line.startsWith('link ')) {
      const linkLine = line.slice(5).trim()
      const parsed = parseLinkLine({ text: linkLine })

      if (parsed) {
        // Check for child lines (base, site)
        while (i < lines.length) {
          const nextRaw = lines[i]!
          const nextIndent = nextRaw.length - nextRaw.trimStart().length
          const nextLine = nextRaw.trim()

          if (!nextLine || nextLine.startsWith('#')) {
            i++
            continue
          }

          if (nextIndent <= indent) {break}

          // Skip child directives (base, site) for now
          i++
        }

        link.push(parsed)
      }

      continue
    }

    if (line.startsWith('hook ')) {
      const hookParts = line.slice(5).trim().split(',')

      if (hookParts.length >= 2) {
        const hookName = hookParts[0]!.trim()
        const hookTask = hookParts
          .slice(1)
          .join(',')
          .trim()
          .replace(/^task\s+/, '')

        hook[hookName] = hookTask
      }

      continue
    }
  }

  return {
    host,
    name,
    mark,
    head,
    mind: mind.length > 0 ? mind : undefined,
    lock,
    sort,
    term: term.length > 0 ? term : undefined,
    link,
    hook: Object.keys(hook).length > 0 ? hook : undefined,
    role,
    test,
    book: bookDir,
    line: lineDir,
    call: callDir,
    task: taskDir,
    hide,
    site,
    view,
    deck: deck.length > 0 ? deck : undefined,
    devLink: devLink.length > 0 ? devLink : undefined,
    hostLink: hostLink.length > 0 ? hostLink : undefined,
  }
}

function parseMindLine(input: { text: string }): DeckMind {
  const parts = input.text.split(',').map(p => p.trim())
  const name = extractAngle(parts[0]!)
  const entry: DeckMind = { name }

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]!.trim()

    if (part.startsWith('base ')) {
      entry.base = extractAngle(part.slice(5).trim())
    } else if (part.startsWith('site ')) {
      entry.site = extractAngle(part.slice(5).trim())
    }
  }

  return entry
}

function parseHostBlock(input: {
  lines: string[]
  index: number
  parentIndent: number
}): { group: DeckHostGroup; nextIndex: number } {
  const { lines, parentIndent } = input

  let i = input.index

  const raw = lines[i]!
  const line = raw.trim()
  const registry = extractAngle(line.slice(5).trim())
  const groupLinks: DeckLink[] = []
  i++

  while (i < lines.length) {
    const nextRaw = lines[i]!
    const nextIndent = nextRaw.length - nextRaw.trimStart().length
    const nextLine = nextRaw.trim()

    if (!nextLine || nextLine.startsWith('#')) {
      i++
      continue
    }

    if (nextIndent <= parentIndent) {break}

    if (nextLine.startsWith('link ')) {
      const parsed = parseLinkLine({ text: nextLine.slice(5).trim() })

      if (parsed) {groupLinks.push(parsed)}
    }

    i++
  }

  return {
    group: { registry, link: groupLinks },
    nextIndex: i,
  }
}

function parseLinkLine(input: { text: string }): DeckLink | undefined {
  const parts = input.text.split(',').map(p => p.trim())
  const nameStr = parts[0]

  if (!nameStr) {return undefined}

  let markHold: MarkHold = {
    form: 'wild',
    major: 0,
  }

  let have: number | undefined

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]!.trim()

    if (part.startsWith('mark ')) {
      const markText = extractAngle(part.slice(5).trim())
      markHold = parseMarkHold(markText)
    }

    if (part.startsWith('have ')) {
      have = parseInt(part.slice(5).trim(), 10)
    }
  }

  return {
    name: nameStr,
    mark: markHold,
    have,
  }
}

function extractAngle(text: string): string {
  if (text.startsWith('<') && text.endsWith('>')) {
    return text.slice(1, -1)
  }

  return text
}

export function writeManifest(input: {
  manifest: DeckManifest
}): string {
  const lines: string[] = []
  const m = input.manifest

  const fullName = m.host ? `@${m.host}/${m.name}` : m.name
  lines.push(`deck ${fullName}`)
  lines.push(`  mark <${showMark(m.mark)}>`)

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
    const markStr = writeMarkHold({ hold: dep.mark })

    let line = `  link ${dep.name}, mark <${markStr}>`

    if (dep.have !== undefined) {
      line += `, have ${dep.have}`
    }

    lines.push(line)
  }

  if (m.hostLink) {
    for (const group of m.hostLink) {
      lines.push(`  host <${group.registry}>`)

      for (const dep of group.link) {
        const markStr = writeMarkHold({ hold: dep.mark })
        lines.push(`    link ${dep.name}, mark <${markStr}>`)
      }
    }
  }

  if (m.devLink && m.devLink.length > 0) {
    lines.push(`  case work`)

    for (const dep of m.devLink) {
      const markStr = writeMarkHold({ hold: dep.mark })
      lines.push(`    link ${dep.name}, mark <${markStr}>`)
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

function writeMarkHold(input: { hold: MarkHold }): string {
  switch (input.hold.form) {
    case 'exact':
      return showMark(input.hold.mark)

    case 'wild': {
      const minor =
        input.hold.minor !== undefined ? `${input.hold.minor}` : 'x'

      const patch =
        input.hold.patch !== undefined ? `${input.hold.patch}` : 'x'

      return `${input.hold.major}.${minor}.${patch}`
    }

    case 'band':
      return `${showMark(input.hold.base)}..${showMark(input.hold.head)}`
    case 'test':
      return input.hold.list
        .map(w => writeMarkHold({ hold: w }))
        .join('|')
  }
}
