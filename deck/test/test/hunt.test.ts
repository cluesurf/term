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
import { DEFAULT_FUZZ_CORPUS } from '@term/test/code/compiler-fuzz'
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

describe('the default fuzz corpus', () => {
  it('is current syntax, so mutants start from programs the compiler accepts', () => {
    for (const entry of DEFAULT_FUZZ_CORPUS) {
      expect(entry).not.toMatch(/\bmark \d|\bwave (true|false)\b|\bbust\b|\bsend kink\b|\bmark async\b/)
      const r = compile({ file: 'fuzz.tree', text: entry }, { resolve: none })
      expect(r.ok, `${entry}\n${JSON.stringify(r.ok ? [] : r.diagnostics.map(d => d.message))}`).toBe(true)
    }
  })
})
