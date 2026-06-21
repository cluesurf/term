import { Mark, MarkBand, MarkHold, MarkTest, MarkWild } from './form'

const MARK_PATTERN = /^(\d+)\.(\d+|x)\.(\d+|x)(?:-(.+))?$/

export function parseMark(text: string): Mark {
  const match = text.match(MARK_PATTERN)
  if (!match) {
    throw new Error(`Invalid version: ${text}`)
  }

  const major = parseInt(match[1]!, 10)
  const minor = match[2] === 'x' ? 0 : parseInt(match[2]!, 10)
  const patch = match[3] === 'x' ? 0 : parseInt(match[3]!, 10)
  const prerelease = match[4]

  return { major, minor, patch, prerelease }
}

export function parseMarkHold(text: string): MarkHold {
  // union: "0.14.x|0.15.x"
  if (text.includes('|')) {
    const parts = text.split('|').map(p => p.trim())
    const list = parts.map(p => {
      const parsed = parseMarkHold(p)
      if (parsed.form !== 'wild') {
        throw new Error(`Union members must be wildcard versions: ${p}`)
      }
      return parsed
    })
    return { form: 'test', list }
  }

  // range: "1.0.0..2.0.0"
  if (text.includes('..')) {
    const parts = text.split('..')
    if (parts.length !== 2) {
      throw new Error(`Invalid range version: ${text}`)
    }
    return {
      form: 'band',
      base: parseMark(parts[0]!),
      head: parseMark(parts[1]!),
    }
  }

  // wildcard: "1.x.x" or "1.2.x"
  if (text.includes('x')) {
    const match = text.match(/^(\d+)\.(x|\d+)\.(x|\d+)$/)
    if (!match) {
      throw new Error(`Invalid wildcard version: ${text}`)
    }
    const result: MarkWild = {
      form: 'wild',
      major: parseInt(match[1]!, 10),
    }
    if (match[2] !== 'x') {
      result.minor = parseInt(match[2]!, 10)
    }
    if (match[3] !== 'x') {
      result.patch = parseInt(match[3]!, 10)
    }
    return result
  }

  // caret: "^1.2.3" -> treat as 1.x.x
  if (text.startsWith('^')) {
    const mark = parseMark(text.slice(1))
    return { form: 'wild', major: mark.major }
  }

  // tilde: "~1.2.3" -> treat as 1.2.x
  if (text.startsWith('~')) {
    const mark = parseMark(text.slice(1))
    return { form: 'wild', major: mark.major, minor: mark.minor }
  }

  return { form: 'exact', mark: parseMark(text) }
}

export function showMark(mark: Mark): string {
  const base = `${mark.major}.${mark.minor}.${mark.patch}`
  if (mark.prerelease) {
    return `${base}-${mark.prerelease}`
  }
  return base
}

export function compareMark(a: Mark, b: Mark): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch

  if (a.prerelease && !b.prerelease) return -1
  if (!a.prerelease && b.prerelease) return 1
  if (a.prerelease && b.prerelease) {
    return a.prerelease < b.prerelease
      ? -1
      : a.prerelease > b.prerelease
        ? 1
        : 0
  }

  return 0
}

export function markMatch(mark: Mark, hold: MarkHold): boolean {
  switch (hold.form) {
    case 'exact':
      return compareMark(mark, hold.mark) === 0

    case 'wild':
      if (mark.major !== hold.major) return false
      if (hold.minor !== undefined && mark.minor !== hold.minor)
        return false
      if (hold.patch !== undefined && mark.patch !== hold.patch)
        return false
      return true

    case 'band':
      return (
        compareMark(mark, hold.base) >= 0 &&
        compareMark(mark, hold.head) < 0
      )

    case 'test':
      return hold.list.some(wild => markMatch(mark, wild))
  }
}

export function pickBestMark(input: {
  versions: Array<Mark>
  hold: MarkHold
}): Mark | undefined {
  const matching = input.versions
    .filter(v => markMatch(v, input.hold))
    .sort((a, b) => compareMark(b, a))
  return matching[0]
}

export function bumpMark(input: {
  mark: Mark
  level: 1 | 2 | 3
}): Mark {
  switch (input.level) {
    case 1:
      return {
        major: input.mark.major + 1,
        minor: 0,
        patch: 0,
      }
    case 2:
      return {
        major: input.mark.major,
        minor: input.mark.minor + 1,
        patch: 0,
      }
    case 3: {
      // even patch numbers only for published versions
      const next = input.mark.patch + 1
      const even = next % 2 === 0 ? next : next + 1
      return {
        major: input.mark.major,
        minor: input.mark.minor,
        patch: even,
      }
    }
  }
}
