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

import { readFileSync, writeFileSync } from 'node:fs'
import { compile } from '@term/make/code/compile/compile'
import { makeRng, type Rng } from './property'

/**
 * A small seed corpus of valid, self-contained Term programs, in CURRENT syntax. The first entry read `mark 42`
 * until 2026-10-02, a literal retired long before: every mutant of it started from a program the compiler already
 * refused, so the campaign spent its runs on the error path. deck/test/test/hunt.test.ts holds every entry to
 * compiling clean.
 */
export const DEFAULT_FUZZ_CORPUS: string[] = [
  `task answer
  like number
  send back
    code 42
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
      code 1
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

// the head words the compiler recognizes - swapping these stresses the mill. Current heads only: `wave` was a
// retired literal head and `code` (the number literal) was missing.
const KEYWORDS = [
  'task', 'call', 'send', 'back', 'take', 'like', 'form', 'link', 'case',
  'fork', 'hook', 'walk', 'save', 'host', 'read', 'make', 'bind', 'load',
  'find', 'mark', 'text', 'code', 'halt', 'turn', 'show', 'fuse', 'tree',
  'note', 'wait', 'dock', 'rule', 'have', 'must',
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
  // per crash signature, the smallest program found that still raises it, shrunk from the smallest the fuzzer hit.
  // Absent when the campaign did not get to shrinking (the watchdog fired while it shrank)
  shrunk?: { signature: string; input: string; from: string }[]
  // the inputs whose compile took longer than the budget, slowest first, each timed twice and its faster time kept
  slow?: { input: string; ms: number }[]
}

// what a crash is known by: its message's first line. Two crashes of one signature are one defect
export function signatureOf(error: string): string {
  return error.split('\n')[0]!.slice(0, 100)
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
  // a compile slower than this is reported in `slow`. Timed only after the corpus has been compiled once, so the
  // first compile's start-up is not charged to an input, and an input over it is timed again and its faster time kept
  perfBudgetMs?: number
}): FuzzReport {
  const runs = input.runs ?? 2000
  const rng = makeRng(input.seed ?? 1)
  const corpus = [...input.corpus]
  const codesSeen = new Set<number>()
  const crashes: Crash[] = []
  const slow: { input: string; ms: number }[] = []
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
    const started = performance.now()
    const result = tryCompile(text)
    const took = performance.now() - started

    if (input.perfBudgetMs !== undefined && took > input.perfBudgetMs) {
      const again = performance.now()
      tryCompile(text)
      const ms = Math.min(took, performance.now() - again)

      if (ms > input.perfBudgetMs) {
        slow.push({ input: text, ms: Math.round(ms) })
      }
    }

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
    ...(input.perfBudgetMs !== undefined ? { slow: slow.sort((a, b) => b.ms - a.ms).slice(0, 5) } : {}),
  }
}

/**
 * SHRINK A FAILING INPUT to a smaller one that `keeps` still holds of: delta debugging (Zeller's ddmin) over its
 * lines, then the same over the words of each line that is left, until no single line and no single word can go.
 * The words are what make a crash readable: a line down to `call f` says more than the twenty-word line it was.
 *
 * `keeps` is the whole judgment, which is what lets a test hold this to a failure it states exactly. For a crash it
 * is "compiling this raises the same signature", never "raises anything": a shrink that slides to another crash
 * reports a program that does not show the defect found. `limit` bounds the attempts, since each is a compile.
 */
export function shrinkInput(input: string, keeps: (text: string) => boolean, limit = 4000): string {
  let tries = 0
  const holds = (text: string): boolean => tries++ < limit && keeps(text)

  // ddmin over the parts of a text joined by `join`: drop a chunk, keep the drop when it still fails, and halve the
  // chunks when no chunk can go, down to single parts
  const ddmin = (parts: string[], join: (parts: string[]) => string): string[] => {
    let current = parts
    let chunks = 2

    while (current.length >= 2 && tries < limit) {
      const size = Math.ceil(current.length / chunks)
      let dropped = false

      for (let start = 0; start < current.length; start += size) {
        const rest = [...current.slice(0, start), ...current.slice(start + size)]

        if (rest.length > 0 && holds(join(rest))) {
          current = rest
          chunks = Math.max(chunks - 1, 2)
          dropped = true
          break
        }
      }

      if (!dropped) {
        if (chunks >= current.length) {
          break
        }

        chunks = Math.min(chunks * 2, current.length)
      }
    }

    // a single part that still fails alone is as small as a list goes, but one part may be droppable entirely
    if (current.length === 1 && holds(join([]))) {
      return []
    }

    return current
  }

  let lines = ddmin(input.split('\n'), parts => parts.join('\n'))

  // then each line's words, its indentation kept, since a line's depth is part of the program
  for (let at = 0; at < lines.length && tries < limit; at++) {
    const line = lines[at]!
    const indent = line.match(/^\s*/)![0]
    const words = line.slice(indent.length).split(/\s+/).filter(Boolean)

    if (words.length < 2) {
      continue
    }

    const kept = ddmin(words, parts => [...lines.slice(0, at), indent + parts.join(' '), ...lines.slice(at + 1)].join('\n'))
    lines = [...lines.slice(0, at), indent + kept.join(' '), ...lines.slice(at + 1)]
  }

  return lines.join('\n')
}

/**
 * Shrink a crash: the smallest program that still makes the compiler throw with the SAME signature. `probeFile`, when
 * given, holds each candidate before it compiles, as the fuzz loop's does, so a candidate that hangs is reported by
 * the watchdog as the hang it is.
 */
export function shrinkCrash(input: string, signature: string, probeFile?: string): string {
  return shrinkInput(input, text => {
    if (probeFile) writeFileSync(probeFile, text)
    const result = tryCompile(text)

    return 'crash' in result && signatureOf(result.crash) === signature
  })
}

/**
 * One fuzz campaign as a CHILD PROCESS body: `<report-out> <probe-file> <runs> <seed> [<corpus.json>]`. The
 * optional corpus file is a JSON list of extra seed programs (the hunted project's own files), added to
 * DEFAULT_FUZZ_CORPUS. Writes the FuzzReport to `report-out`; a parent that finds no report knows the campaign did
 * not finish.
 *
 * It lives here, as a function, so the built CLI can carry it inside its own bundle and fork ITSELF to run it
 * (`term hunt` does, through `HUNT_FUZZ_CHILD`). The old parent spawned `npx tsx <dir>/fuzz-campaign.ts` beside
 * the running module, and inside host/line.js that directory is host/, which holds no such file: the child failed,
 * no report was written, and the run printed `no crashes, no hangs` having fuzzed nothing.
 */
export function runFuzzCampaign(args: string[]): FuzzReport {
  const [reportOut, probeFile, runsArg, seedArg, corpusFile, budgetArg] = args

  if (!reportOut) {
    throw new Error('fuzz campaign: no report path given')
  }

  const extra = corpusFile
    ? (JSON.parse(readFileSync(corpusFile, 'utf8')) as string[])
    : []

  const report = fuzzCompiler({
    corpus: [...DEFAULT_FUZZ_CORPUS, ...extra],
    runs: runsArg ? Number(runsArg) : 3000,
    seed: seedArg ? Number(seedArg) : 7,
    probeFile,
    ...(budgetArg ? { perfBudgetMs: Number(budgetArg) } : {}),
  })

  // the report as fuzzed, BEFORE shrinking: a shrink that hangs is killed by the watchdog, and what was found must
  // survive it
  writeFileSync(reportOut, JSON.stringify(report))

  // then each signature's smallest crash, shrunk to the smallest program that still raises it
  const smallest = new Map<string, string>()

  for (const crash of report.crashes) {
    const signature = signatureOf(crash.error)
    const known = smallest.get(signature)

    if (known === undefined || crash.input.length < known.length) {
      smallest.set(signature, crash.input)
    }
  }

  report.shrunk = [...smallest].map(([signature, from]) => ({ signature, input: shrinkCrash(from, signature, probeFile), from }))
  writeFileSync(reportOut, JSON.stringify(report))

  return report
}

/** Shrink a crashing input to the smallest program that still crashes the same way. */
export function minimizeCrash(input: string): string {
  const first = tryCompile(input)

  return 'crash' in first ? shrinkCrash(input, signatureOf(first.crash)) : input
}
