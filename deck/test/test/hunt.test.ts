// `term hunt` fails CLOSED: a check that did not run is never reported as a pass.
//
// Every case here is a shape that shipped as a silent pass. The built CLI spawned a fuzz campaign at a path that
// exists only in source, so the child failed, no report came back, and the run said `no crashes, no hangs`. The
// default corpus pointed at a directory a user project does not have, so it read nothing and said CLEAN. A fuzz
// child is stood in for by a one-line node script, so each failure mode is exact rather than hoped for.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { compile } from '@term/make/code/compile/compile'
import { DEFAULT_FUZZ_CORPUS, minimizeCrash, shrinkInput } from '@term/test/code/compiler-fuzz'
import { huntSeedCompiler, renderHunt, type FuzzEntry } from '@term/test/code/seed-hunt'

const none = () => undefined

function project(): { root: string; files: string[] } {
  const root = mkdtempSync(path.join(tmpdir(), 'hunt-test-'))
  const file = path.join(root, 'answer.tree')
  writeFileSync(file, 'task answer\n  like number\n  send back\n    code 42\n')
  return { root, files: [file] }
}

// a fake fuzz child: `node -e <body>`, handed the campaign args after it
function child(body: string): FuzzEntry {
  return { command: process.execPath, args: ['-e', body] }
}

// a child that writes a well-formed report: argv after `-e` is [reportOut, probeFile, runs, seed, corpus]
const writesReport = child(
  "require('fs').writeFileSync(process.argv[1], JSON.stringify({runs: Number(process.argv[3]), crashes: [], codesSeen: [], corpusGrew: 0}))",
)

describe('term hunt fails closed', () => {
  it('passes only when every check ran on at least one input', () => {
    const { root, files } = project()
    const result = huntSeedCompiler({ root, resolve: none, files, runs: 5, seeds: 2, fuzzEntry: writesReport })

    expect(result.unrun).toEqual([])
    expect(result.corpus.files).toBe(1)
    expect(result.corpus.compiled).toBe(1)
    expect(result.fuzz.runs).toBe(10)
    expect(result.backends).toEqual(['typescript', 'rust', 'kotlin', 'swift'])
    expect(result.ok).toBe(true)
    expect(renderHunt(result)).toMatch(/hunt CLEAN: 1 file\(s\) read, 10 fuzz run\(s\), 4 backend\(s\) emitted/)
  })

  it('fails when no file was read', () => {
    const { root } = project()
    const result = huntSeedCompiler({ root, resolve: none, files: [], runs: 5, seeds: 1, fuzzEntry: writesReport })

    expect(result.ok).toBe(false)
    expect(result.findings).toBe(0)
    expect(result.unrun.join('\n')).toMatch(/no \.tree files read/)
    expect(renderHunt(result)).toMatch(/hunt INCOMPLETE/)
    expect(renderHunt(result)).not.toMatch(/CLEAN/)
  })

  it('fails when a glob names a directory with no .tree files', () => {
    const { root } = project()
    const result = huntSeedCompiler({ root, resolve: none, glob: 'missing', runs: 5, seeds: 1, fuzzEntry: writesReport })

    expect(result.ok).toBe(false)
    expect(result.unrun.join('\n')).toMatch(/no \.tree files read under missing/)
  })

  it('fails when the fuzz child exits non-zero', () => {
    const { root, files } = project()
    const result = huntSeedCompiler({
      root, resolve: none, files, runs: 5, seeds: 1,
      fuzzEntry: child("process.stderr.write('Cannot find module fuzz-campaign.ts'); process.exit(3)"),
    })

    expect(result.ok).toBe(false)
    expect(result.fuzz.runs).toBe(0)
    expect(result.unrun.join('\n')).toMatch(/fuzz seed 1: the campaign exited 3: Cannot find module/)
    expect(renderHunt(result)).toMatch(/NOTHING FUZZED/)
  })

  it('fails when the fuzz child exits 0 but writes no report', () => {
    const { root, files } = project()
    const result = huntSeedCompiler({ root, resolve: none, files, runs: 5, seeds: 1, fuzzEntry: child('') })

    expect(result.ok).toBe(false)
    expect(result.unrun.join('\n')).toMatch(/wrote no report/)
  })

  it('fails when the fuzz command cannot start', () => {
    const { root, files } = project()
    const result = huntSeedCompiler({
      root, resolve: none, files, runs: 5, seeds: 1,
      fuzzEntry: { command: path.join(root, 'no-such-binary'), args: [] },
    })

    expect(result.ok).toBe(false)
    expect(result.unrun.join('\n')).toMatch(/could not start/)
  })

  it('fails when the campaigns executed zero runs', () => {
    const { root, files } = project()
    const result = huntSeedCompiler({
      root, resolve: none, files, runs: 5, seeds: 1,
      fuzzEntry: child(
        "require('fs').writeFileSync(process.argv[1], JSON.stringify({runs: 0, crashes: [], codesSeen: [], corpusGrew: 0}))",
      ),
    })

    expect(result.ok).toBe(false)
    expect(result.unrun.join('\n')).toMatch(/executed zero runs/)
  })

  it('fails when asked for zero seeds', () => {
    const { root, files } = project()
    const result = huntSeedCompiler({ root, resolve: none, files, runs: 5, seeds: 0, fuzzEntry: writesReport })

    expect(result.ok).toBe(false)
    expect(result.unrun.join('\n')).toMatch(/nothing was fuzzed/)
  })

  it('reports a hang, with the input that hung, as a finding', () => {
    const { root, files } = project()
    const result = huntSeedCompiler({
      root, resolve: none, files, runs: 5, seeds: 1, fuzzTimeoutSec: 1,
      fuzzEntry: child("require('fs').writeFileSync(process.argv[2], 'task loop'); for (;;) {}"),
    })

    expect(result.ok).toBe(false)
    expect(result.findings).toBe(1)
    expect(result.hangs).toEqual([{ input: 'task loop' }])
    expect(renderHunt(result)).toMatch(/hunt FOUND 1 issue/)
  })

  it('reports a crash signature from a campaign as a finding', () => {
    const { root, files } = project()
    const result = huntSeedCompiler({
      root, resolve: none, files, runs: 5, seeds: 1,
      fuzzEntry: child(
        "require('fs').writeFileSync(process.argv[1], JSON.stringify({runs: 5, crashes: [{input: 'x', error: 'TypeError: boom\\n  at y', generation: 0}], codesSeen: [], corpusGrew: 0}))",
      ),
    })

    expect(result.ok).toBe(false)
    expect(result.crashes.found.map(c => c.signature)).toEqual(['TypeError: boom'])
    // the program that raised it comes with it, so the crash can be reproduced without fuzzing again
    expect(result.crashes.found[0]!.input).toBe('x')
    expect(renderHunt(result)).toMatch(/TypeError: boom\n\s+\| x/)
  })

  it('a watchdog that fires before the first input is a run that did not happen, not a hang', () => {
    const { root, files } = project()
    const result = huntSeedCompiler({
      root, resolve: none, files, runs: 5, seeds: 1, fuzzTimeoutSec: 1,
      fuzzEntry: child('for (;;) {}'),
    })

    expect(result.ok).toBe(false)
    expect(result.hangs).toEqual([])
    expect(result.unrun.join('\n')).toMatch(/watchdog fired before the campaign wrote its first input/)
  })

  it('runs the real fuzz campaign from source', () => {
    const { root, files } = project()
    const result = huntSeedCompiler({ root, resolve: none, files, runs: 20, seeds: 1, fuzzTimeoutSec: 120 })

    expect(result.unrun).toEqual([])
    expect(result.fuzz.seedsRun).toBe(1)
    expect(result.fuzz.runs).toBe(20)
    expect(result.fuzz.corpusAdded).toBe(1)
    expect(result.ok).toBe(true)
  }, 150_000)
})

// A crash is reported SHRUNK: the smallest program that still raises its signature, by delta debugging over lines and
// then words (compiler-fuzz.ts `shrinkInput`). Until 2026-10-05 it was the shortest mutant the fuzzer happened to hit.
// The failure here is stated exactly, so the shrink is held to an answer rather than to "smaller"
describe('crashes are shrunk', () => {
  // fails while some line holds the word `boom` and some line holds `anchor`
  const fails = (text: string): boolean => {
    const lines = text.split('\n')

    return lines.some(line => line.trim().split(/\s+/).includes('boom')) && lines.some(line => line.includes('anchor'))
  }
  const input = ['task a', '  call x y boom z', '  save q', '    read r', 'anchor here now', '  back 1'].join('\n')

  it('to the lines and words the failure needs, the indentation kept', () => {
    expect(shrinkInput(input, fails)).toBe('  boom\nanchor')
  })

  it('to a program no single line or word can leave', () => {
    const small = shrinkInput(input, fails)
    const lines = small.split('\n')

    lines.forEach((_, at) => expect(fails(lines.filter((__, other) => other !== at).join('\n'))).toBe(false))
    lines.forEach((line, at) => {
      const indent = line.match(/^\s*/)![0]
      const words = line.trim().split(/\s+/)

      words.forEach((_, drop) => {
        const fewer = [...lines.slice(0, at), indent + words.filter((__, w) => w !== drop).join(' '), ...lines.slice(at + 1)]
        expect(fails(fewer.join('\n'))).toBe(false)
      })
    })
  })

  it('within its attempt limit, answering what it reached', () => {
    let calls = 0
    const counted = (text: string): boolean => {
      calls++
      return fails(text)
    }
    const small = shrinkInput(input, counted, 3)

    expect(calls).toBeLessThanOrEqual(3)
    expect(fails(small)).toBe(true)
  })

  it('leaves a program that does not crash as it is', () => {
    expect(minimizeCrash('task answer\n  like number\n  back 42\n')).toBe('task answer\n  like number\n  back 42\n')
  })

  it('and the hunt reports the shrunk program, saying what it was shrunk from', () => {
    const { root, files } = project()
    const result = huntSeedCompiler({
      root, resolve: none, files, runs: 5, seeds: 1,
      fuzzEntry: child(
        "require('fs').writeFileSync(process.argv[1], JSON.stringify({runs: 5, crashes: [{input: 'a\\nx\\nb', error: 'TypeError: boom\\n  at y', generation: 0}], codesSeen: [], corpusGrew: 0, shrunk: [{signature: 'TypeError: boom', input: 'x', from: 'a\\nx\\nb'}]}))",
      ),
    })

    expect(result.crashes.found).toEqual([{ signature: 'TypeError: boom', input: 'x', from: 'a\nx\nb' }])
    expect(renderHunt(result)).toMatch(/TypeError: boom {2}\(shrunk from 3 lines to 1\)\n\s+\| x/)
  })

  it('and a campaign the watchdog stops while it shrinks keeps the crash it found, unshrunk, beside the hang', () => {
    const { root, files } = project()
    const result = huntSeedCompiler({
      root, resolve: none, files, runs: 5, seeds: 1, fuzzTimeoutSec: 1,
      fuzzEntry: child(
        "const fs = require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({runs: 5, crashes: [{input: 'a\\nx', error: 'TypeError: boom', generation: 0}], codesSeen: [], corpusGrew: 0})); fs.writeFileSync(process.argv[2], 'x'); for (;;) {}",
      ),
    })

    expect(result.hangs).toEqual([{ input: 'x' }])
    expect(result.crashes.found).toEqual([{ signature: 'TypeError: boom', input: 'a\nx' }])
    expect(result.fuzz.runs).toBe(5)
    expect(result.findings).toBe(2)
  })
})

// The compile budget is held: on the corpus, the fastest of each file's three compiles, and on every fuzzed input,
// timed twice. `perfBudgetMs` was taken and never read until 2026-10-05
describe('the compile budget', () => {
  it('fails a corpus file whose every compile is over it', () => {
    const { root, files } = project()
    const result = huntSeedCompiler({ root, resolve: none, files, runs: 5, seeds: 1, perfBudgetMs: 0, fuzzEntry: writesReport })
    const perf = result.corpus.violations.filter(v => v.violation.oracle === 'perf')

    expect(perf).toHaveLength(1)
    expect(perf[0]!.violation.detail).toMatch(/compile took \d+ms, the fastest of three \(budget 0ms\)/)
    expect(result.ok).toBe(false)
  })

  it('passes it when the corpus compiles inside it', () => {
    const { root, files } = project()
    const result = huntSeedCompiler({ root, resolve: none, files, runs: 5, seeds: 1, perfBudgetMs: 60_000, fuzzEntry: writesReport })

    expect(result.corpus.violations).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('hands it to each fuzz campaign, and a slow input it reports is a finding', () => {
    const { root, files } = project()
    // the budget is the sixth argument after `-e`, and this child reports it back as the slow input's time
    const result = huntSeedCompiler({
      root, resolve: none, files, runs: 5, seeds: 1, perfBudgetMs: 60_000,
      fuzzEntry: child(
        "require('fs').writeFileSync(process.argv[1], JSON.stringify({runs: 5, crashes: [], codesSeen: [], corpusGrew: 0, slow: [{input: 'slow one', ms: Number(process.argv[6]) + 1}]}))",
      ),
    })

    expect(result.slow).toEqual([{ input: 'slow one', ms: 60_001 }])
    expect(result.findings).toBe(1)
    expect(renderHunt(result)).toMatch(/1 SLOW INPUT\(S\), over the compile budget:\n {4}- 60001ms\n\s+\| slow one/)
  })
})

describe('the default fuzz corpus', () => {
  it('is current syntax, so mutants start from programs the compiler accepts', () => {
    for (const entry of DEFAULT_FUZZ_CORPUS) {
      expect(entry).not.toMatch(/\bmark \d|\bwave (true|false)\b|\bbust\b|\bsend kink\b|\bmark async\b/)
      const r = compile({ file: 'fuzz.tree', text: entry }, { resolve: none })
      expect(r.ok, `${entry}\n${JSON.stringify(r.ok ? [] : r.diagnostics.map(d => d.message))}`).toBe(true)
    }
  })
})
