import * as fs from 'fs/promises'
import * as path from 'path'
import { logGood, logFail, logStep, logWarn, formatError, fade } from '../tint'

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
}): Promise<void> {
  logStep('Running benchmarks...')

  try {
    const { discoverTimeBlocks, runTimeBlock, buildSuite } = await import(
      '@cluesurf/mesh.tree/code/time/runner'
    )
    const { formatTable, formatJson } = await import(
      '@cluesurf/mesh.tree/code/time/output'
    )
    const { compileText } = await import('@cluesurf/mesh.tree/code/make')
    const { parse } = await import('@cluesurf/tree')
    const { readCard } = await import('@cluesurf/mesh.tree/code/read')

    // Find .tree files
    const files = input.file
      ? [path.resolve(input.root, input.file)]
      : await findTreeFiles(input.root)

    if (files.length === 0) {
      logFail('No .tree files found')
      process.exit(1)
    }

    const allResults: Array<{
      name: string
      iterations: number
      mean_ns: number
      median_ns: number
      std_dev_ns: number
      min_ns: number
      max_ns: number
      ops_per_sec: number
      cv: number
      timings_ns: number[]
    }> = []

    for (const file of files) {
      const text = await fs.readFile(file, 'utf-8')
      const lead = parse({ file, text })
      if (!lead || !lead.tree) continue

      const card = readCard({ tree: lead.tree, file })
      const blocks = discoverTimeBlocks({ card, file })

      // Filter by name if provided
      const filtered = input.filter
        ? blocks.filter((b: { name: string }) =>
            b.name.includes(input.filter!),
          )
        : blocks

      if (filtered.length === 0) continue

      // Compile the file to JS for execution
      const compiled = compileText({
        text,
        file,
        target: 'typescript',
        parse,
      })

      if (compiled.errors.length > 0) {
        logWarn(`${file}: ${compiled.errors.length} compilation errors`)
        continue
      }

      // Extract and run each time block
      for (const block of filtered) {
        const fnName = `time/${block.name}`
        const bookEntry = compiled.book.get(fnName)
        if (!bookEntry) {
          logWarn(`Could not find compiled entry for ${block.name}`)
          continue
        }

        // Create a runnable function from the compiled code
        try {
          const fn = new Function(compiled.code + `\nreturn ${fnName.replace(/[/-]/g, '_')}()`)
          const result = runTimeBlock({
            block,
            run: fn as () => void,
          })
          allResults.push(result)
        } catch (err) {
          logWarn(`${block.name}: ${formatError(err)}`)
        }
      }
    }

    if (allResults.length === 0) {
      logFail('No benchmarks found')
      process.exit(1)
    }

    const suite = buildSuite(allResults)

    // Output results
    if (input.json) {
      console.log(formatJson(suite))
    } else {
      console.log('')
      console.log(formatTable(allResults))
      console.log('')
    }

    // Save baseline if requested
    if (input.save) {
      const dir = path.join(input.root, '.seed', 'time')
      await fs.mkdir(dir, { recursive: true })
      const savePath = path.join(dir, `${input.save}.json`)
      await fs.writeFile(savePath, formatJson(suite))
      logGood(`Saved baseline to ${savePath}`)
    }

    // Compare against baseline if requested
    if (input.compare) {
      const comparePath = path.join(
        input.root,
        '.seed',
        'time',
        `${input.compare}.json`,
      )
      try {
        const baselineText = await fs.readFile(comparePath, 'utf-8')
        const baselineSuite = JSON.parse(baselineText)
        const baseline = {
          results: baselineSuite.results ?? baselineSuite.benchmarks ?? [],
          timestamp: baselineSuite.timestamp ?? '',
          platform: baselineSuite.platform ?? '',
        }
        const { compareResults, formatComparison } = await import(
          '@cluesurf/mesh.tree/code/time/compare'
        )
        const comparison = compareResults({
          current: allResults,
          baseline,
        })

        if (input.markdown) {
          const { formatMarkdown } = await import(
            '@cluesurf/mesh.tree/code/time/ci'
          )
          console.log(formatMarkdown({ result: comparison, suite }))
        } else {
          console.log('')
          console.log(formatComparison(comparison))
        }

        if (comparison.regressions > 0) {
          logWarn(`${comparison.regressions} significant regression(s) detected`)
        }

        // CI gating
        if (input.failOnRegression != null) {
          const { shouldFail } = await import(
            '@cluesurf/mesh.tree/code/time/ci'
          )
          if (shouldFail({ result: comparison, maxRegressionPct: input.failOnRegression })) {
            logFail(`Regression exceeds ${input.failOnRegression}% threshold`)
            process.exit(1)
          }
        }
      } catch {
        logFail(`Could not read baseline: ${comparePath}`)
      }
    }

    // Save history entry
    if (input.save) {
      try {
        const historyDir = path.join(input.root, '.seed', 'time', 'history')
        await fs.mkdir(historyDir, { recursive: true })
        const { buildHistoryEntry } = await import(
          '@cluesurf/mesh.tree/code/time/ci'
        )
        const entry = buildHistoryEntry({ suite })
        const historyPath = path.join(historyDir, `${Date.now()}.json`)
        await fs.writeFile(historyPath, JSON.stringify(entry, null, 2))
      } catch {
        // History save is best-effort
      }
    }

    // Show history for a specific benchmark
    if (input.history) {
      await showHistory({ root: input.root, name: input.history })
    }

    logGood(`${allResults.length} benchmark(s) complete`)
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}

async function findTreeFiles(dir: string): Promise<string[]> {
  const results: string[] = []
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        results.push(...(await findTreeFiles(full)))
      } else if (entry.isFile() && entry.name.endsWith('.tree')) {
        results.push(full)
      }
    }
  } catch {
    // skip unreadable directories
  }
  return results
}

async function showHistory(input: { root: string; name: string }): Promise<void> {
  const historyDir = path.join(input.root, '.seed', 'time', 'history')
  try {
    const files = await fs.readdir(historyDir)
    const jsonFiles = files.filter(f => f.endsWith('.json')).sort().slice(-20)

    const entries: Array<{ timestamp: string; mean_ns: number }> = []

    for (const file of jsonFiles) {
      const text = await fs.readFile(path.join(historyDir, file), 'utf-8')
      const data = JSON.parse(text)
      const bench = data.benchmarks?.find((b: { name: string }) => b.name === input.name)
      if (bench) {
        entries.push({ timestamp: data.timestamp ?? file, mean_ns: bench.mean_ns })
      }
    }

    if (entries.length === 0) {
      logWarn(`No history found for "${input.name}"`)
      return
    }

    console.log('')
    console.log(`History for "${input.name}" (last ${entries.length} entries):`)
    console.log('-'.repeat(50))

    for (const entry of entries) {
      const date = entry.timestamp.slice(0, 19)
      const ns = entry.mean_ns
      const timeStr = ns < 1000 ? `${ns.toFixed(1)}ns`
        : ns < 1_000_000 ? `${(ns / 1000).toFixed(1)}us`
        : ns < 1_000_000_000 ? `${(ns / 1_000_000).toFixed(1)}ms`
        : `${(ns / 1_000_000_000).toFixed(2)}s`
      console.log(`  ${date}  ${timeStr}`)
    }
  } catch {
    logWarn(`No history directory found at ${historyDir}`)
  }
}
