import { Code, MarkBand, CodeHold, MarkTest, MarkWild } from './form'

const MARK_PATTERN = /^(\d+)\.(\d+|x)\.(\d+|x)(?:-(.+))?$/

export function parseCode(text: string): Code {
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

export function parseCodeHold(text: string): CodeHold {
  // union: "0.14.x|0.15.x"
  if (text.includes('|')) {
    const parts = text.split('|').map(p => p.trim())
    const list = parts.map(p => {
      const parsed = parseCodeHold(p)

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
      base: parseCode(parts[0]!),
      head: parseCode(parts[1]!),
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

  // caret: compatible-with-`code`, the npm rule. `^1.2.3` allows >=1.2.3 <2.0.0. For a leading-zero version the left-
  // most non-zero element is locked instead: `^0.2.3` is >=0.2.3 <0.3.0, `^0.0.3` is >=0.0.3 <0.0.4. The lower bound is
  // the version itself (not a coarse `1.x.x`), so the band excludes earlier patches.
  if (text.startsWith('^')) {
    const code = parseCode(text.slice(1))

    let head: Code

    if (code.major > 0) {
      head = { major: code.major + 1, minor: 0, patch: 0 }
    } else if (code.minor > 0) {
      head = { major: 0, minor: code.minor + 1, patch: 0 }
    } else {
      head = { major: 0, minor: 0, patch: code.patch + 1 }
    }

    return { form: 'band', base: code, head }
  }

  // tilde: approximately-equivalent, the npm rule. `~1.2.3` allows >=1.2.3 <1.3.0 (patch changes within the minor).
  if (text.startsWith('~')) {
    const code = parseCode(text.slice(1))

    return {
      form: 'band',
      base: code,
      head: { major: code.major, minor: code.minor + 1, patch: 0 },
    }
  }

  return { form: 'exact', code: parseCode(text) }
}

export function showCode(code: Code): string {
  const base = `${code.major}.${code.minor}.${code.patch}`

  if (code.prerelease) {
    return `${base}-${code.prerelease}`
  }

  return base
}

export function compareCode(a: Code, b: Code): number {
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

export function codeMatch(code: Code, hold: CodeHold): boolean {
  switch (hold.form) {
    case 'exact':
      return compareCode(code, hold.code) === 0

    case 'wild':
      if (code.major !== hold.major) {return false}

      if (hold.minor !== undefined && code.minor !== hold.minor)
        {return false}

      if (hold.patch !== undefined && code.patch !== hold.patch)
        {return false}

      return true

    case 'band':
      return (
        compareCode(code, hold.base) >= 0 &&
        compareCode(code, hold.head) < 0
      )

    case 'test':
      return hold.list.some(wild => codeMatch(code, wild))
  }
}

export function pickBestCode(input: {
  versions: Code[]
  hold: CodeHold
}): Code | undefined {
  const matching = input.versions
    .filter(v => codeMatch(v, input.hold))
    .sort((a, b) => compareCode(b, a))

  return matching[0]
}

export function bumpCode(input: {
  code: Code
  level: 1 | 2 | 3
}): Code {
  switch (input.level) {
    case 1:
      return {
        major: input.code.major + 1,
        minor: 0,
        patch: 0,
      }
    case 2:
      return {
        major: input.code.major,
        minor: input.code.minor + 1,
        patch: 0,
      }

    case 3: {
      // even patch numbers only for published versions
      const next = input.code.patch + 1
      const even = next % 2 === 0 ? next : next + 1

      return {
        major: input.code.major,
        minor: input.code.minor,
        patch: even,
      }
    }
  }
}
