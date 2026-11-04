// A package a suite borrows without the Term package declaring it: the browser the web suites drive
// (`@playwright/test`), and `string-width`, which the cell grid's width table is held to. Each is resolved from the Term
// root when installed there, else from the folder TERM_TEST_MODULES names, any project that has it installed (the
// parent repository's term:test alias names its mesh/). Not found, the suite skips the leg that needs it and says why.
// A helper, not a suite: it sits beside temp.ts, where the gate looks for no suite.

import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = resolve(HERE, '..')

// the folders a package is looked for in, in order
function places(): string[] {
  const given = process.env.TERM_TEST_MODULES?.trim()

  return given ? [TERM, resolve(given)] : [TERM]
}

// why a package was not found, naming where it was looked for
function missing(name: string): string {
  const given = process.env.TERM_TEST_MODULES?.trim()

  return given
    ? `no ${name} in the Term root or in ${resolve(given)} (TERM_TEST_MODULES)`
    : `no ${name} in the Term root, and TERM_TEST_MODULES names no project that has it`
}

/** The package's entry file, or why it is not installed where it is looked for */
export function borrowedFile(name: string): { file: string } | { reason: string } {
  for (const place of places()) {
    try {
      return { file: createRequire(join(place, 'package.json')).resolve(name) }
    } catch {
      // not in this place: the next one
    }
  }

  return { reason: missing(name) }
}

/** The package as `require` loads it, or why it is not installed where it is looked for */
export function borrowed<T>(name: string): { value: T } | { reason: string } {
  for (const place of places()) {
    try {
      return { value: createRequire(join(place, 'package.json'))(name) as T }
    } catch {
      // not in this place: the next one
    }
  }

  return { reason: missing(name) }
}
