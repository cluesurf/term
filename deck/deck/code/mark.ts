import { Mark, MarkBand, MarkHold, MarkTest, MarkWild } from './form'

const MARK_PATTERN = /^(\d+)\.(\d+|x)\.(\d+|x)(?:-(.+))?$/

export function parseMark(text: string): Mark {
  const match = MARK_PATTERN.exec(text)

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
    const match = /^(\d+)\.(x|\d+)\.(x|\d+)$/.exec(text)

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

  // caret: compatible-with-`mark`, the npm rule. `^1.2.3` allows >=1.2.3 <2.0.0. For a leading-zero version the left-
  // most non-zero element is locked instead: `^0.2.3` is >=0.2.3 <0.3.0, `^0.0.3` is >=0.0.3 <0.0.4. The lower bound is
  // the version itself (not a coarse `1.x.x`), so the band excludes earlier patches.
  if (text.startsWith('^')) {
    const mark = parseMark(text.slice(1))

    let head: Mark

    if (mark.major > 0) {
      head = { major: mark.major + 1, minor: 0, patch: 0 }
    } else if (mark.minor > 0) {
      head = { major: 0, minor: mark.minor + 1, patch: 0 }
    } else {
      head = { major: 0, minor: 0, patch: mark.patch + 1 }
    }

    return { form: 'band', base: mark, head }
  }

  // tilde: approximately-equivalent, the npm rule. `~1.2.3` allows >=1.2.3 <1.3.0 (patch changes within the minor).
  if (text.startsWith('~')) {
    const mark = parseMark(text.slice(1))

    return {
      form: 'band',
      base: mark,
      head: { major: mark.major, minor: mark.minor + 1, patch: 0 },
    }
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
  if (a.major !== b.major) {return a.major - b.major}

  if (a.minor !== b.minor) {return a.minor - b.minor}

  if (a.patch !== b.patch) {return a.patch - b.patch}

  if (a.prerelease && !b.prerelease) {return -1}

  if (!a.prerelease && b.prerelease) {return 1}

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
      if (mark.major !== hold.major) {return false}

      if (hold.minor !== undefined && mark.minor !== hold.minor)
        {return false}

      if (hold.patch !== undefined && mark.patch !== hold.patch)
        {return false}

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
  versions: Mark[]
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
