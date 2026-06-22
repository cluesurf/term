import fsp from 'fs/promises'
import path from 'path'
import { Lockfile, LockEntry, Mark } from './form'
import { parseMark, showMark } from './mark'

export async function loadLockfile(input: {
  dir: string
}): Promise<Lockfile | undefined> {
  const file = path.join(input.dir, 'lock.tree')

  try {
    const text = await fsp.readFile(file, 'utf-8')

    return parseLockfile({ text })
  } catch {
    return undefined
  }
}

export function parseLockfile(input: { text: string }): Lockfile {
  const lines = input.text.split('\n')

  let version = 1

  const decks: LockEntry[] = []

  let current: LockEntry | undefined

  for (const rawLine of lines) {
    const line = rawLine.trim()

    if (!line || line.startsWith('#')) {continue}

    if (line.startsWith('lock ')) {
      const lockText = extractAngle(line.slice(5).trim())
      version = parseInt(lockText, 10)
      continue
    }

    if (line.startsWith('deck ')) {
      if (current) {
        decks.push(current)
      }

      current = {
        name: line.slice(5).trim(),
        mark: { major: 0, minor: 0, patch: 0 },
        hash: '',
        site: '',
        link: [],
      }
      continue
    }

    if (!current) {continue}

    if (line.startsWith('mark ')) {
      const markText = extractAngle(line.slice(5).trim())
      current.mark = parseMark(markText)
      continue
    }

    if (line.startsWith('hash ')) {
      current.hash = extractAngle(line.slice(5).trim())
      continue
    }

    if (line.startsWith('site ')) {
      current.site = extractAngle(line.slice(5).trim())
      continue
    }

    if (line.startsWith('link ')) {
      const linkParts = line.slice(5).trim().split(',')
      const linkName = linkParts[0]!.trim()

      let linkMark = ''

      for (const part of linkParts.slice(1)) {
        const trimmed = part.trim()

        if (trimmed.startsWith('mark ')) {
          linkMark = extractAngle(trimmed.slice(5).trim())
        }
      }

      current.link.push({ name: linkName, mark: linkMark })
      continue
    }
  }

  if (current) {
    decks.push(current)
  }

  return { version, decks }
}

function extractAngle(text: string): string {
  if (text.startsWith('<') && text.endsWith('>')) {
    return text.slice(1, -1)
  }

  return text
}

export function writeLockfile(input: { lockfile: Lockfile }): string {
  const lines: string[] = []

  lines.push(`lock <${input.lockfile.version}>`)
  lines.push('')

  const sorted = [...input.lockfile.decks].sort((a, b) =>
    a.name.localeCompare(b.name),
  )

  for (const entry of sorted) {
    lines.push(`deck ${entry.name}`)
    lines.push(`  mark <${showMark(entry.mark)}>`)
    lines.push(`  hash <${entry.hash}>`)
    lines.push(`  site <${entry.site}>`)

    for (const dep of entry.link) {
      lines.push(`  link ${dep.name}, mark <${dep.mark}>`)
    }

    lines.push('')
  }

  return lines.join('\n')
}

export async function saveLockfile(input: {
  dir: string
  lockfile: Lockfile
}): Promise<void> {
  const file = path.join(input.dir, 'lock.tree')
  const text = writeLockfile({ lockfile: input.lockfile })
  await fsp.writeFile(file, text, 'utf-8')
}
