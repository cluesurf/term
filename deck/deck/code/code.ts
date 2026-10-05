// Versions and holds, for the package manager's TypeScript callers. The logic is Term: deck/deck/code/version.tree
// (self-hosting, 2026-10-05, paired against this file's original by tmp/pair-version.ts). This face keeps the shapes
// the callers know: a field the port writes as nothing (`""`, `-1`) is left out here, as the original left it out, and
// a refusal is an `Error` with the original's message.

import { Code, CodeHold, MarkWild } from './form'
import * as version from '@term/deck/code/version'

type PortCode = { major: number; minor: number; patch: number; prerelease: string; build: string }
type PortHold =
  | { form: 'exact'; code: PortCode }
  | { form: 'wild'; major: number; minor: number; patch: number }
  | { form: 'band'; base: PortCode; head: PortCode }
  | { form: 'test'; list: PortHold[] }

function toPort(code: Code): PortCode {
  return { major: code.major, minor: code.minor, patch: code.patch, prerelease: code.prerelease ?? '', build: code.build ?? '' }
}

// `parseCode` answers `prerelease` always (undefined when there is none) and `build` only when there is one
function fromParsed(code: PortCode): Code {
  return {
    major: code.major,
    minor: code.minor,
    patch: code.patch,
    prerelease: code.prerelease === '' ? undefined : code.prerelease,
    ...(code.build !== '' ? { build: code.build } : {}),
  }
}

// a code the original built field by field: a prerelease only when there is one, never a build
function fromBuilt(code: PortCode): Code {
  return {
    major: code.major,
    minor: code.minor,
    patch: code.patch,
    ...(code.prerelease !== '' ? { prerelease: code.prerelease } : {}),
  }
}

function wildOf(hold: Extract<PortHold, { form: 'wild' }>): MarkWild {
  return {
    form: 'wild',
    major: hold.major,
    ...(hold.minor >= 0 ? { minor: hold.minor } : {}),
    ...(hold.patch >= 0 ? { patch: hold.patch } : {}),
  }
}

// a caret or tilde band's head is built, its base parsed
function fromPortHold(hold: PortHold, text: string): CodeHold {
  switch (hold.form) {
    case 'exact':
      return { form: 'exact', code: fromParsed(hold.code) }
    case 'wild':
      return wildOf(hold)
    case 'band':
      return { form: 'band', base: fromParsed(hold.base), head: text.includes('..') ? fromParsed(hold.head) : fromBuilt(hold.head) }
    case 'test':
      return { form: 'test', list: hold.list.map(member => wildOf(member as Extract<PortHold, { form: 'wild' }>)) }
  }
}

function toPortHold(hold: CodeHold): PortHold {
  switch (hold.form) {
    case 'exact':
      return { form: 'exact', code: toPort(hold.code) }
    case 'wild':
      return { form: 'wild', major: hold.major, minor: hold.minor ?? -1, patch: hold.patch ?? -1 }
    case 'band':
      return { form: 'band', base: toPort(hold.base), head: toPort(hold.head) }
    case 'test':
      return { form: 'test', list: hold.list.map(toPortHold) }
  }
}

// a Term refusal raised as the original's Error
function refused<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    const note = (error as { note?: unknown }).note

    throw typeof note === 'string' ? new Error(note) : error
  }
}

export function parseCode(text: string): Code {
  return fromParsed(refused(() => version.parseCode(text) as PortCode))
}

export function parseCodeHold(text: string): CodeHold {
  return fromPortHold(refused(() => version.parseCodeHold(text) as PortHold), text)
}

export function showCode(code: Code): string {
  return version.showCode(toPort(code) as never)
}

export function compareCode(a: Code, b: Code): number {
  return version.compareCode(toPort(a) as never, toPort(b) as never)
}

export function codeMatch(code: Code, hold: CodeHold): boolean {
  return version.codeMatch(toPort(code) as never, toPortHold(hold) as never)
}

// the original answered one of the codes it was given, so the face hands back that very object
export function pickBestCode(input: { versions: Code[]; hold: CodeHold }): Code | undefined {
  const best = version.pickBestCode(input.versions.map(toPort) as never, toPortHold(input.hold) as never) as { found: boolean; code: PortCode }

  if (!best.found) {
    return undefined
  }

  return input.versions.find(v => compareCode(v, best.code as Code) === 0 && (v.build ?? '') === best.code.build)
}

export function bumpCode(input: { code: Code; level: 1 | 2 | 3 }): Code {
  return fromBuilt(version.bumpCode(toPort(input.code) as never, input.level) as PortCode)
}

export function bumpPrerelease(input: { code: Code; id: string }): Code {
  return fromBuilt(version.bumpPrerelease(toPort(input.code) as never, input.id) as PortCode)
}
