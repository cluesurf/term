// Version comparison and npm-style range satisfaction, built on the package manager's `Code` (semver) type so the
// scanner and the resolver agree on version ordering. Dependency-free and pure. Covers the range grammar that OSV
// ECOSYSTEM ranges and the registry bulk advisory service emit: comparators (`<`, `<=`, `>`, `>=`, `=`), AND by
// whitespace, OR by `||`, hyphen ranges (`1.0.0 - 2.0.0`), the `x`/`*` wildcards, and caret/tilde (delegated to the
// package manager's own `parseCodeHold` / `codeMatch`).

import type { Code } from '@cluesurf/deck.tree'
import {
  compareCode,
  parseCodeHold,
  codeMatch,
} from '@cluesurf/deck.tree'

// parse a version string into a Code, tolerating a leading `v`/`=`, missing minor/patch (padded with 0), and a
// prerelease suffix. Returns undefined for anything that is not a plain dotted version, so callers can skip it
// rather than crash (a range like `*` is handled before this is reached).
export function toCode(text: string): Code | undefined {
  let value = text.trim()

  if (value.startsWith('v') || value.startsWith('=')) {
    value = value.slice(1).trim()
  }

  if (value === '' || value === '*' || value === 'x') {
    return undefined
  }

  // split off a prerelease / build suffix
  let prerelease: string | undefined
  const dash = value.indexOf('-')

  if (dash !== -1) {
    prerelease = value.slice(dash + 1)
    value = value.slice(0, dash)
  }

  const parts = value.split('.')

  if (parts.length === 0 || parts.length > 3) {
    return undefined
  }

  const nums: number[] = []

  for (const part of parts) {
    if (part === 'x' || part === 'X' || part === '*') {
      break
    }

    if (!/^\d+$/.test(part)) {
      return undefined
    }

    nums.push(parseInt(part, 10))
  }

  if (nums.length === 0) {
    return undefined
  }

  return {
    major: nums[0]!,
    minor: nums[1] ?? 0,
    patch: nums[2] ?? 0,
    ...(prerelease ? { prerelease } : {}),
  }
}

// compare two version strings. Returns <0 if a<b, 0 if equal, >0 if a>b. Unparseable versions sort last.
export function compareVersion(a: string, b: string): number {
  const ma = toCode(a)
  const mb = toCode(b)

  if (!ma && !mb) {
    return 0
  }

  if (!ma) {
    return 1
  }

  if (!mb) {
    return -1
  }

  return compareCode(ma, mb)
}

// does a single comparator (`>=1.2.0`, `<2.0.0`, `=1.0.0`, bare `1.2.3`, `*`) hold for `version`?
function satisfiesComparator(version: string, comparator: string): boolean {
  const raw = comparator.trim()

  if (raw === '' || raw === '*' || raw === 'x') {
    return true
  }

  const match = /^(>=|<=|>|<|=|~|\^)?\s*(.+)$/.exec(raw)

  if (!match) {
    return false
  }

  const operator = match[1] ?? '='
  const operand = match[2]!.trim()

  // caret / tilde delegate to the package manager's own range engine (its band semantics): test the INSTALLED
  // version against the hold parsed from the operand
  if (operator === '^' || operator === '~') {
    const target = version ? toCode(version) : undefined

    if (!target) {
      return true
    }

    return codeMatch(target, parseCodeHold(`${operator}${operand}`))
  }

  // a wildcard operand (`1.x`, `1`) with no comparator is a prefix match: reuse parseCodeHold's wildcard form
  if (operator === '=' && /(^|\.)(x|\*)$|^\d+$|^\d+\.\d+$/.test(operand)) {
    const target = version ? toCode(version) : undefined

    if (target) {
      const normalized = operand
        .replace(/\*/g, 'x')
        .split('.')
        .concat(['x', 'x'])
        .slice(0, 3)
        .join('.')

      return codeMatch(target, parseCodeHold(normalized))
    }
  }

  const cmp = compareVersion(version, operand)

  switch (operator) {
    case '>':
      return cmp > 0
    case '>=':
      return cmp >= 0
    case '<':
      return cmp < 0
    case '<=':
      return cmp <= 0
    case '=':
      return cmp === 0
    default:
      return false
  }
}

// does `version` satisfy an npm-style range? Supports OR (`||`), AND (whitespace), hyphen ranges, and the
// comparators above. An empty range means "any".
export function satisfies(version: string, range: string): boolean {
  const trimmed = range.trim()

  if (trimmed === '' || trimmed === '*') {
    return true
  }

  // OR across `||`
  for (const orPart of trimmed.split('||')) {
    const clause = orPart.trim()

    // hyphen range: `a - b` means `>=a <=b`
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(clause)

    if (hyphen) {
      if (
        satisfiesComparator(version, `>=${hyphen[1]}`) &&
        satisfiesComparator(version, `<=${hyphen[2]}`)
      ) {
        return true
      }

      continue
    }

    // AND across whitespace-separated comparators
    const comparators = clause.split(/\s+/).filter(Boolean)
    const all = comparators.every(c => satisfiesComparator(version, c))

    if (all) {
      return true
    }
  }

  return false
}
