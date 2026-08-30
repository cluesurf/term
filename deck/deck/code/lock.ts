import fsp from 'fs/promises'
import path from 'path'
import { Lockfile, LockEntry, Code } from './form'
import { parseCode, showCode } from './code'
import { readTree, valueOf, formsWith } from './read'
import { parseLockfileMill } from './mill'

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
  // the lockfile reads THROUGH THE MILL (mill-self-hosting-0005); the hand extraction below is the retired
  // reference path
  return parseLockfileMill(input)
}

export function parseLockfileByHand(input: { text: string }): Lockfile {
  const result = readTree({ file: 'lock.tree', text: input.text })

  if (!result.ok) {
    const first = result.diagnostics[0]

    throw new Error(
      `lock.tree could not be parsed${first ? `: ${first.message}` : ''}`,
    )
  }

  let version = 1
  const decks: LockEntry[] = []

  for (const form of result.forms) {
    if (form.head === 'lock') {
      const stated = Number.parseInt(form.value ?? '', 10)

      if (Number.isFinite(stated)) {
        version = stated
      }

      continue
    }

    if (form.head !== 'deck') {
      continue
    }

    decks.push({
      name: form.terms[0] ?? '',
      code: parseCode(valueOf(form, 'code') ?? '0.0.0'),
      hash: valueOf(form, 'hash') ?? '',
      site: valueOf(form, 'site') ?? '',
      link: formsWith(form, 'link').map(link => ({
        name: link.terms[0] ?? '',
        code: valueOf(link, 'code') ?? '',
      })),
    })
  }

  return { version, decks }
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
    lines.push(`  code <${showCode(entry.code)}>`)
    lines.push(`  hash <${entry.hash}>`)
    lines.push(`  site <${entry.site}>`)

    for (const dep of entry.link) {
      lines.push(`  link ${dep.name}, code <${dep.code}>`)
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
