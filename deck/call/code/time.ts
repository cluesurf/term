import * as fs from 'fs/promises'
import * as path from 'path'
import {
  logGood,
  logFail,
  logStep,
  logWarn,
  formatError,
  fade,
} from '@term/make/code/tint'
import { render } from '@term/make/code/parser/diagnostic'
import { collectTreeFiles } from '@term/call/code/files'
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
  // profiling mode: `seed time --cpu <file>` / `--memory <file>` profiles one file's hotspots instead of benchmarking.
  if (input.cpu || input.memory) {
    await runProfile({
      root: input.root,
      cpu: input.cpu,
      memory: input.memory,
      top: input.top,
    })

    return
  }

  logStep('Running benchmarks...')

  try {
    const files = input.file
      ? [path.resolve(input.root, input.file)]
      : await collectTreeFiles([], input.root)

    if (files.length === 0) {
      logFail('No .tree files found')
      process.exit(1)
    }

    const allResults: BenchmarkResult[] = []

    for (const file of files) {
      const text = await fs.readFile(file, 'utf-8')
      const relative = path.relative(input.root, file)

      let module

      try {
        module = compileBenchmarks({
          text,
          file: relative,
          filter: input.filter,
        })
      } catch (err) {
        if (err instanceof CompileFailure) {
          logWarn(
            `${relative}: ${err.diagnostics.length} compilation error(s)`,
          )

          for (const diagnostic of err.diagnostics) {
            console.error(render(diagnostic, text.split('\n')))
          }

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
      logFail(
        'No benchmarks found (define a zero-argument `task time-...`)',
      )
      process.exit(1)
    }

    const suite = buildSuite(allResults)

    if (input.json) {
      console.log(formatJson(suite))
    } else {
      console.log('')
      console.log(formatTable(allResults))
      console.log('')
    }

    if (input.save) {
      const dir = path.join(input.root, '.base/term', 'time')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(
        path.join(dir, `${input.save}.json`),
        formatJson(suite),
      )
      logGood(`Saved baseline "${input.save}"`)

      const historyDir = path.join(dir, 'history')
      await fs.mkdir(historyDir, { recursive: true })
      await fs.writeFile(
        path.join(historyDir, `${Date.now()}.json`),
        JSON.stringify(buildHistoryEntry({ suite }), null, 2),
      )
    }

    if (input.compare) {
      const comparePath = path.join(
        input.root,
        '.base/term',
        'time',
        `${input.compare}.json`,
      )

      try {
        const baselineSuite = JSON.parse(
          await fs.readFile(comparePath, 'utf-8'),
        )

        const baseline = {
          results:
            baselineSuite.results ?? baselineSuite.benchmarks ?? [],
        }

        const comparison = compareResults({
          current: allResults,
          baseline,
        })

        if (input.markdown) {
          console.log(formatMarkdown({ result: comparison, suite }))
        } else {
          console.log('')
          console.log(formatComparison(comparison))
        }

        if (comparison.regressions > 0) {
          logWarn(`${comparison.regressions} regression(s) detected`)
        }

        if (
          input.failOnRegression != null &&
          shouldFail({
            result: comparison,
            maxRegressionPct: input.failOnRegression,
          })
        ) {
          logFail(
            `Regression exceeds ${input.failOnRegression}% threshold`,
          )
          process.exit(1)
        }
      } catch {
        logFail(`Could not read baseline: ${comparePath}`)
      }
    }

    if (input.history) {
      await showHistory({ root: input.root, name: input.history })
    }

    logGood(`${allResults.length} benchmark(s) complete`)
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
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

  try {
    await fs.access(filePath)
  } catch {
    logFail(`File not found: ${target}`)
    process.exit(1)
  }

  const text = await fs.readFile(filePath, 'utf-8')
  const relative = path.relative(input.root, filePath)
  const name = path.basename(filePath, '.tree')

  try {
    if (input.cpu) {
      logStep('CPU profiling...')
      const result = await runCpuProfile({
        text,
        file: relative,
        root: input.root,
        name,
        top: input.top,
      })
      console.log('')
      console.log(formatCpuResult(result))
      console.log('')
      logGood('CPU profile complete')
    } else {
      logStep('Memory profiling...')
      const result = await runMemoryProfile({
        text,
        file: relative,
        root: input.root,
        name,
      })
      console.log('')
      console.log(formatMemoryResult(result))
      console.log('')
      logGood('Memory profile complete')
    }
  } catch (err) {
    if (err instanceof CompileFailure) {
      logFail(`${err.diagnostics.length} compilation error(s)`)

      for (const diagnostic of err.diagnostics) {
        console.error(render(diagnostic, text.split('\n')))
      }

      process.exit(1)
    }

    logFail(formatError(err))
    process.exit(1)
  }
}

async function showHistory(input: {
  root: string
  name: string
}): Promise<void> {
  const historyDir = path.join(input.root, '.base/term', 'time', 'history')

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
      logWarn(`No history found for "${input.name}"`)

      return
    }

    console.log('')
    console.log(`History for "${input.name}" (last ${entries.length}):`)

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

      console.log(fade(`  ${entry.timestamp.slice(0, 19)}  ${time}`))
    }
  } catch {
    logWarn(`No history at ${historyDir}`)
  }
}
