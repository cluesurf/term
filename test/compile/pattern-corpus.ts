// A corpus of real patterns for the pattern differential (regex-engine-0014): every regular expression literal in the
// Term toolchain's own TypeScript, read with the TypeScript parser, each with real inputs. Importing it runs nothing.
//
// A JavaScript literal becomes a Term pattern by its flags: `i`, `m` and `s` lead it as `(?ims)`, and `g`, `y`, `d`
// and `u` change no match and are dropped. A literal with any other flag is left out. The inputs are lines of the same
// sources, at most 60 code points: for each pattern up to three the literal matches in V8 and two it does not, so
// every case exercises something. V8 only picks the inputs; the differential holds every answer to Term's reference.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

export type CorpusCase = { pattern: string; inputs: string[]; origin: string }

const SKIP = new Set(['node_modules', 'host', '.base', 'tmp', 'link', 'target', '.build'])

function sources(dir: string, out: string[]): void {
  if (!existsSync(dir)) {
    return
  }

  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name) || name.endsWith('-cache')) {
      continue
    }

    const full = join(dir, name)

    if (statSync(full).isDirectory()) {
      sources(full, out)
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
}

// every regular expression literal in one file, as written
function literals(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      found.push(node.getText(source))
    }

    ts.forEachChild(node, visit)
  }

  visit(source)

  return found
}

// `/body/flags` as a Term pattern, or nothing for a flag Term has no reading of
function termPattern(literal: string): { pattern: string; js: RegExp } | undefined {
  const cut = literal.lastIndexOf('/')
  const body = literal.slice(1, cut)
  const flags = literal.slice(cut + 1)

  if (!/^[gimsuyd]*$/.test(flags)) {
    return undefined
  }

  let js: RegExp

  try {
    js = new RegExp(body, flags.replace(/[gyd]/g, ''))
  } catch {
    return undefined
  }

  const inline = [...'ims'].filter(f => flags.includes(f)).join('')

  return { pattern: `${inline ? `(?${inline})` : ''}${body}`, js }
}

// the corpus: up to `limit` distinct patterns, in a fixed order, each with its inputs
export function harvestCorpus(termRoot: string, limit: number): CorpusCase[] {
  const files: string[] = []

  for (const dir of ['deck/make/code', 'deck/call/code', 'deck/deck/code', 'deck/flow/code', 'deck/scan/code', 'deck/test/code']) {
    sources(join(termRoot, dir), files)
  }

  // the input pool: every 7th short line of the sources, so it is fixed and spread over every file
  const pool: string[] = []
  const found: { literal: string; origin: string }[] = []

  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const origin = relative(termRoot, file)

    for (const literal of literals(file, text)) {
      found.push({ literal, origin })
    }

    text.split('\n').forEach((line, k) => {
      const trimmed = line.trim()

      if (k % 7 === 0 && trimmed.length > 0 && [...trimmed].length <= 60) {
        pool.push(trimmed)
      }
    })
  }

  const seen = new Set<string>()
  const cases: CorpusCase[] = []

  for (const { literal, origin } of found) {
    if (cases.length >= limit) {
      break
    }

    const read = termPattern(literal)

    if (!read || seen.has(read.pattern)) {
      continue
    }

    seen.add(read.pattern)

    const hits: string[] = []
    const misses: string[] = []

    for (const line of pool) {
      if (hits.length >= 3 && misses.length >= 2) {
        break
      }

      read.js.lastIndex = 0

      if (read.js.test(line)) {
        if (hits.length < 3) {
          hits.push(line)
        }
      } else if (misses.length < 2) {
        misses.push(line)
      }
    }

    cases.push({ pattern: read.pattern, inputs: [...hits, ...misses], origin })
  }

  return cases
}
