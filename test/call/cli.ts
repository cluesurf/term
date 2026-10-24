// The CLI every test/call suite runs, found in one place (decision 013 part 1, term-cli-in-term-0189).
//
// TERM_LINE names another bundle, such as host/term-line.js built from the console before host/line.js switches
// to it, so a suite can be tried against it without replacing the CLI a running gate uses. Unset, it is the built
// CLI of this checkout, <term>/host/line.js. This file is a helper, not a suite: task/term/test.ts skips it.

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// the Term package root, deck/term/deck/term
export const TERM = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// where the built CLI sits inside an install or a payload, relative to its root
export const LINE_IN_INSTALL = 'host/line.js'

// the CLI under test
export const LINE = process.env.TERM_LINE ? resolve(process.env.TERM_LINE) : join(TERM, LINE_IN_INSTALL)
