// `term time`: the project's `time-*` benchmarks, or with --cpu / --memory one file's profile. The table, the JSON,
// the comparison, the markdown and the history are DATA, on stdout through printData. What happened around them (a
// file that did not compile, a saved baseline, regressions, the gate) is items through code/output.ts.

import * as fs from 'fs/promises'
import * as path from 'path'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { readable } from '@term/call/code/test-preprocess'
import { closeRun, count, field, location, openRun, printData, problemOf, report, showPath } from '@term/call/code/output'
import {
  compileBenchmarks,
  runBenchmarks,
} from '@term/make/code/time/runner'
import { CompileFailure } from '@term/make/code/time/execute'
import {
  buildSuite,
  formatTable,
  formatJson,
} from '@term/make/code/time/output'
import {
  compareResults,
  formatComparison,
  formatMarkdown,
  shouldFail,
  buildHistoryEntry,
} from '@term/make/code/time/compare'
import type { BenchmarkResult } from '@term/make/code/time/stats'
import {
  runCpuProfile,
  formatCpuResult,
} from '@term/make/code/time/cpu'
import {
  runMemoryProfile,
  formatMemoryResult,
} from '@term/make/code/time/memory'
import { findTreeFiles, projectResolver } from '@term/call/code/make'
import { withNativeEnv } from '@term/make/code/compile/native'

export async function callTime(input: {
  root: string
  filter?: string
  file?: string
  json?: boolean
  save?: string
  compare?: string
  failOnRegression?: number
  markdown?: boolean
  history?: string
  cpu?: string
  memory?: string
  top?: number
}): Promise<void> {
  // profiling mode: `term time --cpu <file>` / `--memory <file>` profiles one file's hotspots instead of benchmarking.
  if (input.cpu || input.memory) {
    await runProfile({
      root: input.root,
      cpu: input.cpu,
      memory: input.memory,
      top: input.top,
    })

    return
  }

  openRun({ verb: 'time', root: input.root, facts: [...(input.filter ? [input.filter] : []), ...(input.compare ? [`--compare ${input.compare}`] : [])] })

  // the same resolver `term make` uses, so a benchmark file's imports resolve the way its build does. Without it
  // `term time` reported every imported name as undefined on a project that compiles.
  const resolve = withNativeEnv('node', projectResolver(input.root))

  try {
    // the baseline is read first, so a name that does not exist fails before anything runs. It was read after the
    // run, and a missing one printed `Could not read baseline` and exited 0, `--fail-on-regression` too, so a gate
    // pointed at a misspelled name passed (guides: commands/time, tests/benchmarks, 2026-10-04)
    const baseline = input.compare ? await readBaseline(input.root, input.compare) : undefined

    // the walk `term make` does for node, leaving out `link/`: the manifest and the shelved files are not code
    const link = path.join(input.root, 'link') + path.sep
    const files = input.file
      ? [path.resolve(input.root, input.file)]
      : findTreeFiles(input.root, [], 'node').filter(f => !f.startsWith(link))

    if (files.length === 0) {
      report({ glyph: 'failed', kind: 'problem', subject: 'There is no .tree file to benchmark' })
      process.exit(closeRun({ verdict: 'Nothing benchmarked' }))
    }

    const allResults: BenchmarkResult[] = []

    for (const file of files) {
      // a file of `test` blocks rewritten into tasks, as `term test` and `term roll` do, so it compiles rather than
      // printing a page of `unknown-name` for `test`, `want` and `hold`
      const unit = readable(await fs.readFile(file, 'utf-8'))
      const relative = path.relative(input.root, file)

      let module

      try {
        module = compileBenchmarks({
          text: unit.text,
          file: relative,
          resolve,
          filter: input.filter,
        })
      } catch (err) {
        // a file that does not compile is skipped, not fatal, as it always was: its problems drawn as ▲, since the
        // other files' benchmarks still run and the run still answers
        if (err instanceof CompileFailure) {
          for (const diagnostic of err.diagnostics) {
            reportSkipped(unit.place(diagnostic), input.root)
          }

          report({ glyph: 'warning', verb: 'time', subject: `${relative} did not compile, and its benchmarks did not run`, counts: [count(err.diagnostics.length, 'errors', 'error')] })

          continue
        }

        throw err
      }

      if (module.benchmarks.length === 0) {
        continue
      }

      allResults.push(
        ...(await runBenchmarks({ module, root: input.root })),
      )
    }

    if (allResults.length === 0) {
      report({ glyph: 'failed', kind: 'problem', subject: 'There is no benchmark to run', fields: [field('next', 'define a zero-argument task named time-...')] })
      process.exit(closeRun({ verdict: 'Nothing benchmarked' }))
    }

    const suite = buildSuite(allResults)

    if (input.json) {
      printData(`${formatJson(suite)}\n`)
    } else {
      printData(`\n${formatTable(allResults)}\n\n`)
    }

    if (input.save) {
      const dir = path.join(input.root, '.base/@cluesurf/term', 'time')
      await fs.mkdir(dir, { recursive: true })
      const saved = path.join(dir, `${input.save}.json`)
      await fs.writeFile(saved, formatJson(suite))
      report({ glyph: 'done', verb: 'save', subject: `Baseline ${input.save}`, fields: [location(showPath(saved, input.root))] })

      const historyDir = path.join(dir, 'history')
      await fs.mkdir(historyDir, { recursive: true })
      await fs.writeFile(
        path.join(historyDir, `${Date.now()}.json`),
        JSON.stringify(buildHistoryEntry({ suite }), null, 2),
      )
    }

    if (baseline) {
      const comparison = compareResults({
        current: allResults,
        baseline,
      })

      if (input.markdown) {
        printData(`${formatMarkdown({ result: comparison, suite })}\n`)
      } else {
        printData(`\n${formatComparison(comparison)}\n`)
      }

      const gated =
        input.failOnRegression != null &&
        shouldFail({
          result: comparison,
          maxRegressionPct: input.failOnRegression,
        })

      // a regression is ▲; past the --fail-on-regression threshold it is ✗, and the gate exits 1 at once
      if (comparison.regressions > 0 || gated) {
        report({
          glyph: gated ? 'failed' : 'warning',
          kind: 'problem',
          verb: 'compare',
          subject: `${comparison.regressions} benchmark${comparison.regressions === 1 ? '' : 's'} regressed against ${input.compare}`,
          fields: gated ? [field('budget', `${input.failOnRegression}%`)] : [],
        })
      }

      if (gated) {
        process.exit(closeRun({ verdict: `A regression is past the ${input.failOnRegression}% threshold`, counts: [count(allResults.length, 'benchmarks', 'benchmark')] }))
      }
    }

    if (input.history) {
      await showHistory({ root: input.root, name: input.history })
    }

    closeRun({ verdict: 'Benchmarks complete', counts: [count(allResults.length, 'benchmarks', 'benchmark')] })
  } catch (err) {
    report({ glyph: 'failed', kind: 'problem', subject: err instanceof Error ? err.message : String(err) })
    process.exit(closeRun({ verdict: 'Benchmarks did not complete' }))
  }
}

// a benchmark file's compile problem, as a ▲ problem item: the file is skipped, and the run goes on
function reportSkipped(placed: { diagnostic: Diagnostic; text?: string }, root: string): void {
  report({ ...problemOf(placed.diagnostic, root, placed.text), glyph: 'warning' })
}

// a saved baseline (`term time --save <name>`), or the run stops with exit 1 naming the file it looked for
async function readBaseline(root: string, name: string): Promise<{ results: BenchmarkResult[] }> {
  const where = path.join(root, '.base/@cluesurf/term', 'time', `${name}.json`)

  try {
    const saved = JSON.parse(await fs.readFile(where, 'utf-8'))

    return { results: saved.results ?? saved.benchmarks ?? [] }
  } catch {
    report({ glyph: 'failed', kind: 'problem', subject: `There is no baseline named ${name}`, fields: [field('looked', showPath(where, root)), field('next', `term time --save ${name}`)] })
    process.exit(closeRun({ verdict: 'Nothing compared' }))
  }
}

// profile one file: CPU hotspots (V8 --cpu-prof) or memory (heap delta). Folded into `time` since both answer "how
// expensive is this".
async function runProfile(input: {
  root: string
  cpu?: string
  memory?: string
  top?: number
}): Promise<void> {
  const target = (input.cpu ?? input.memory)!
  const filePath = path.resolve(input.root, target)
  // as above: profiling compiles the file, and it has to compile it the way the build does
  const resolve = withNativeEnv('node', projectResolver(input.root))

  openRun({ verb: 'profile', root: input.root, subject: target, facts: [input.cpu ? 'cpu' : 'memory'] })

  try {
    await fs.access(filePath)
  } catch {
    report({ glyph: 'failed', kind: 'problem', subject: `There is no file ${target}`, fields: [field('looked', showPath(filePath, input.root))] })
    process.exit(closeRun({ verdict: 'Nothing profiled' }))
  }

  const text = await fs.readFile(filePath, 'utf-8')
  const relative = path.relative(input.root, filePath)
  const name = path.basename(filePath, '.tree')

  try {
    // the profile is the answer the user asked for: data on stdout
    if (input.cpu) {
      const result = await runCpuProfile({
        text,
        file: relative,
        resolve,
        root: input.root,
        name,
        top: input.top,
      })
      printData(`\n${formatCpuResult(result)}\n\n`)
      closeRun({ verdict: 'CPU profile complete' })
    } else {
      const result = await runMemoryProfile({
        text,
        file: relative,
        resolve,
        root: input.root,
        name,
      })
      printData(`\n${formatMemoryResult(result)}\n\n`)
      closeRun({ verdict: 'Memory profile complete' })
    }
  } catch (err) {
    if (err instanceof CompileFailure) {
      for (const diagnostic of err.diagnostics) {
        report(problemOf(diagnostic, input.root, diagnostic.file === relative ? text : undefined))
      }

      process.exit(closeRun({ verdict: 'Nothing profiled', counts: [count(err.diagnostics.length, 'errors', 'error')] }))
    }

    report({ glyph: 'failed', kind: 'problem', subject: err instanceof Error ? err.message : String(err) })
    process.exit(closeRun({ verdict: 'Nothing profiled' }))
  }
}

async function showHistory(input: {
  root: string
  name: string
}): Promise<void> {
  const historyDir = path.join(input.root, '.base/@cluesurf/term', 'time', 'history')

  try {
    const files = (await fs.readdir(historyDir))
      .filter(f => f.endsWith('.json'))
      .sort()
      .slice(-20)

    const entries: { timestamp: string; mean_ns: number }[] = []

    for (const file of files) {
      const data = JSON.parse(
        await fs.readFile(path.join(historyDir, file), 'utf-8'),
      )

      const bench = data.benchmarks?.find(
        (b: { name: string }) => b.name === input.name,
      )

      if (bench) {
        entries.push({
          timestamp: data.timestamp ?? file,
          mean_ns: bench.mean_ns,
        })
      }
    }

    if (entries.length === 0) {
      report({ glyph: 'warning', verb: 'history', subject: `There is no history for ${input.name}` })

      return
    }

    // the history is data: one line per run, oldest first
    const lines = ['', `History for "${input.name}" (last ${entries.length}):`]

    for (const entry of entries) {
      const ns = entry.mean_ns
      const time =
        ns < 1_000
          ? `${ns.toFixed(1)}ns`
          : ns < 1_000_000
            ? `${(ns / 1_000).toFixed(1)}us`
            : ns < 1_000_000_000
              ? `${(ns / 1_000_000).toFixed(1)}ms`
              : `${(ns / 1_000_000_000).toFixed(2)}s`

      lines.push(`  ${entry.timestamp.slice(0, 19)}  ${time}`)
    }

    printData(`${lines.join('\n')}\n`)
  } catch {
    report({ glyph: 'warning', verb: 'history', subject: 'There is no history yet', fields: [field('looked', showPath(historyDir, input.root))] })
  }
}
