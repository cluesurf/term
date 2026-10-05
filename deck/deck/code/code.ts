import { Code, MarkBand, CodeHold, MarkTest, MarkWild } from './form'

// `1.2.3`, `1.2.3-rc.1`, `1.2.3+build.4`, `1.2.3-rc.1+build.4`
const MARK_PATTERN = /^(\d+)\.(\d+|x)\.(\d+|x)(?:-([^+]+))?(?:\+([0-9A-Za-z.-]+))?$/

export function parseCode(text: string): Code {
  const match = MARK_PATTERN.exec(text)

  if (!match) {
    throw new Error(`Invalid version: ${text}`)
  }

  const major = parseInt(match[1]!, 10)
  const minor = match[2] === 'x' ? 0 : parseInt(match[2]!, 10)
  const patch = match[3] === 'x' ? 0 : parseInt(match[3]!, 10)
  const prerelease = match[4]
  const build = match[5]

  return { major, minor, patch, prerelease, ...(build !== undefined ? { build } : {}) }
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

  const tagged = code.prerelease ? `${base}-${code.prerelease}` : base

  return code.build ? `${tagged}+${code.build}` : tagged
}

export function compareCode(a: Code, b: Code): number {
  if (a.major !== b.major) {return a.major - b.major}

  if (a.minor !== b.minor) {return a.minor - b.minor}

  if (a.patch !== b.patch) {return a.patch - b.patch}

  if (a.prerelease && !b.prerelease) {return -1}

  if (!a.prerelease && b.prerelease) {return 1}

  if (a.prerelease && b.prerelease) {
    return comparePrerelease(a.prerelease, b.prerelease)
  }

  return 0
}

// Semver 2.0, section 11: dot-separated identifiers left to right, numbers by value, a number below a word, words in
// ASCII order, and a shorter list below a longer one it begins. So `rc.2` < `rc.10` < `rc.10.1` < `rc.a`. It
// compared the whole text, which put `rc.10` below `rc.2`
function comparePrerelease(a: string, b: string): number {
  const left = a.split('.')
  const right = b.split('.')

  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i]!
    const y = right[i]!
    const xNumber = /^\d+$/.test(x)
    const yNumber = /^\d+$/.test(y)

    if (xNumber && yNumber) {
      const difference = Number(x) - Number(y)

      if (difference !== 0) {
        return difference
      }
    } else if (xNumber !== yNumber) {
      return xNumber ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }

  return left.length - right.length
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

    // a pre-release moves to its own release, npm's rule: `1.4.3-rc.2` is followed by `1.4.3`
    case 3:
      return {
        major: input.code.major,
        minor: input.code.minor,
        patch: input.code.prerelease ? input.code.patch : input.code.patch + 1,
      }
  }
}

// `term move mark rc`: the next pre-release named `id`. `1.4.2` moves to `1.4.3-rc.1`, `1.4.3-rc.1` to `1.4.3-rc.2`,
// and a pre-release under another name keeps its version and starts this one: `1.4.3-beta.4` to `1.4.3-rc.1`
export function bumpPrerelease(input: { code: Code; id: string }): Code {
  const { major, minor, patch, prerelease } = input.code

  if (!prerelease) {
    return { major, minor, patch: patch + 1, prerelease: `${input.id}.1` }
  }

  const count = new RegExp(`^${input.id}\\.(\\d+)$`).exec(prerelease)

  return { major, minor, patch, prerelease: `${input.id}.${count ? Number(count[1]) + 1 : 1}` }
}
