/**
 * Compiler fuzzing (Fuzzilli-style, structure-aware): mutate valid Seed
 * `.tree` sources and feed them to the live compiler, hunting for inputs
 * that CRASH it. The oracle is robustness: a correct compiler always
 * returns a result - `ok` or a list of diagnostics - and NEVER throws.
 * Any input that makes `compile` throw is a compiler bug, surfaced here
 * with the exact (minimized) input that triggers it.
 *
 * The mutators are structure-aware at the `.tree` line level (the format
 * is indentation-significant), so the mutants stay close to plausible
 * programs and exercise the parser, mill, resolver, and checker rather
 * than bouncing off the lexer: change indentation, duplicate/delete/swap
 * lines, replace a head word with another keyword, splice lines between
 * corpus entries, truncate. New diagnostic codes seen act as a coverage
 * signal that grows the corpus (the AFL idea), so the search drives
 * toward new compiler behavior.
 */

import { writeFileSync } from 'node:fs'
import { compile } from '@term/make/code/compile/compile'
import { makeRng, type Rng } from './property'

/** A small seed corpus of valid, self-contained Seed programs. */
export const DEFAULT_FUZZ_CORPUS: string[] = [
  `task answer
  like number
  send back
    mark 42
`,
  `form point
  link x, like number
  link y, like number
`,
  `task add-one
  take n, like number
  like number
  send back
    call add
      read n
      mark 1
`,
  `task pick
  take a, like number
  take b, like number
  like number
  fork test
    hook test
      call is-above
        read a
        read b
    hook hold
      send back
        read a
    hook miss
      send back
        read b
`,
]

// the head words the compiler recognizes - swapping these stresses the mill
const KEYWORDS = [
  'task', 'call', 'send', 'back', 'take', 'like', 'form', 'link', 'case',
  'fork', 'hook', 'walk', 'save', 'host', 'read', 'make', 'bind', 'load',
  'find', 'mark', 'text', 'wave', 'halt', 'turn', 'show', 'fuse', 'tree',
]

export type Crash = {
  input: string
  error: string
  // the sequence of mutations that produced it (for understanding)
  generation: number
}

export type FuzzReport = {
  runs: number
  crashes: Crash[]
  // distinct diagnostic codes observed (a coverage proxy)
  codesSeen: number[]
  corpusGrew: number
}

const INDENTS = ['', '  ', '    ', '      ', '\t']

function lines(text: string): string[] {
  return text.split('\n')
}

/** Apply one structure-aware mutation to a `.tree` source. */
function mutate(text: string, corpus: string[], rng: Rng): string {
  const ls = lines(text)
  if (ls.length === 0) return text
  const pick = (n: number) => Math.floor(rng.next() * n)
  const choice = pick(7)

  switch (choice) {
    case 0: {
      // change a line's indentation
      const i = pick(ls.length)
      ls[i] = INDENTS[pick(INDENTS.length)]! + ls[i]!.trimStart()
      return ls.join('\n')
    }
    case 1: {
      // duplicate a line
      const i = pick(ls.length)
      ls.splice(i, 0, ls[i]!)
      return ls.join('\n')
    }
    case 2: {
      // delete a line
      ls.splice(pick(ls.length), 1)
      return ls.join('\n')
    }
    case 3: {
      // swap two lines
      const i = pick(ls.length)
      const j = pick(ls.length)
      ;[ls[i], ls[j]] = [ls[j]!, ls[i]!]
      return ls.join('\n')
    }
    case 4: {
      // replace the head word of a line with a random keyword
      const i = pick(ls.length)
      const indent = ls[i]!.match(/^\s*/)?.[0] ?? ''
      const rest = ls[i]!.trimStart().split(/\s+/).slice(1).join(' ')
      ls[i] = `${indent}${KEYWORDS[pick(KEYWORDS.length)]}${rest ? ' ' + rest : ''}`
      return ls.join('\n')
    }
    case 5: {
      // splice a line in from another corpus entry
      const donor = lines(corpus[pick(corpus.length)]!)
      if (donor.length === 0) return text
      ls.splice(pick(ls.length + 1), 0, donor[pick(donor.length)]!)
      return ls.join('\n')
    }
    default: {
      // truncate at a random line
      return ls.slice(0, pick(ls.length)).join('\n')
    }
  }
}

/** Compile one input, never throwing: returns the diagnostic codes, or a crash. */
function tryCompile(input: string): { codes: number[] } | { crash: string } {
  try {
    const r = compile({ file: 'fuzz.tree', text: input }, { resolve: () => undefined })
    const diags = r.ok ? r.warnings : r.diagnostics
    return { codes: (diags ?? []).map(d => d.code) }
  } catch (error) {
    return { crash: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) }
  }
}

/**
 * Fuzz the compiler from a seed corpus. Runs `runs` mutated inputs,
 * keeps any that reveal a new diagnostic code (coverage-guided corpus
 * growth), and records every input that makes the compiler throw.
 */
export function fuzzCompiler(input: {
  corpus: string[]
  runs?: number
  seed?: number
  mutationsPerRun?: number
  // if set, the input currently under test is written here BEFORE each
  // compile. A non-terminating input cannot be caught in-process, so an
  // out-of-process watchdog kills the run and reads this file to recover
  // the exact input that hung the compiler.
  probeFile?: string
}): FuzzReport {
  const runs = input.runs ?? 2000
  const rng = makeRng(input.seed ?? 1)
  const corpus = [...input.corpus]
  const codesSeen = new Set<number>()
  const crashes: Crash[] = []
  let corpusGrew = 0

  // seed the coverage set with the corpus itself
  for (const entry of corpus) {
    const r = tryCompile(entry)
    if ('codes' in r) for (const c of r.codes) codesSeen.add(c)
  }

  for (let i = 0; i < runs; i++) {
    let text = corpus[Math.floor(rng.next() * corpus.length)]!
    const k = 1 + Math.floor(rng.next() * (input.mutationsPerRun ?? 4))
    for (let m = 0; m < k; m++) text = mutate(text, corpus, rng)

    if (input.probeFile) writeFileSync(input.probeFile, text)
    const result = tryCompile(text)
    if ('crash' in result) {
      crashes.push({ input: text, error: result.crash, generation: i })
      continue
    }

    // coverage-guided: a mutant that hit a new diagnostic code joins the corpus
    let novel = false
    for (const c of result.codes) {
      if (!codesSeen.has(c)) { codesSeen.add(c); novel = true }
    }
    if (novel && corpus.length < 500) {
      corpus.push(text)
      corpusGrew++
    }
  }

  return {
    runs,
    crashes,
    codesSeen: [...codesSeen].sort((a, b) => a - b),
    corpusGrew,
  }
}

/** Shrink a crashing input to a smaller one that still crashes (ddmin-lite). */
export function minimizeCrash(input: string): string {
  let best = input
  let changed = true
  while (changed) {
    changed = false
    const ls = lines(best)
    for (let i = 0; i < ls.length; i++) {
      const candidate = ls.slice(0, i).concat(ls.slice(i + 1)).join('\n')
      const r = tryCompile(candidate)
      if ('crash' in r) {
        best = candidate
        changed = true
        break
      }
    }
  }
  return best
}
