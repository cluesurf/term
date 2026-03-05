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
        const baseline = JSON.parse(baselineText)
        printComparison(allResults, baseline.benchmarks)
      } catch {
        logFail(`Could not read baseline: ${comparePath}`)
      }
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

function printComparison(
  current: Array<{ name: string; mean_ns: number }>,
  baseline: Array<{ name: string; mean_ns: number }>,
): void {
  console.log('')
  console.log(
    'Benchmark'.padEnd(30) +
      'Before'.padEnd(12) +
      'After'.padEnd(12) +
      'Change'.padEnd(12),
  )
  console.log('-'.repeat(66))

  for (const cur of current) {
    const base = baseline.find(b => b.name === cur.name)
    if (!base) continue

    const change = ((cur.mean_ns - base.mean_ns) / base.mean_ns) * 100
    const sign = change > 0 ? '+' : ''
    const changeStr = `${sign}${change.toFixed(1)}%`

    console.log(
      cur.name.padEnd(30) +
        formatNs(base.mean_ns).padEnd(12) +
        formatNs(cur.mean_ns).padEnd(12) +
        changeStr.padEnd(12),
    )
  }
}

function formatNs(ns: number): string {
  if (ns < 1000) return `${ns.toFixed(1)}ns`
  if (ns < 1_000_000) return `${(ns / 1000).toFixed(1)}us`
  if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(1)}ms`
  return `${(ns / 1_000_000_000).toFixed(2)}s`
}
