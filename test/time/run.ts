// Benchmark harness tests that need the host. Run: npx tsx test/time/run.ts
// The pure pieces (stats, durations, comparison and its gate, the spread rule, the table) are Term tests since
// 2026-10-04, deck/make/test/time.tree. What stays here: the saved baseline's on-disk format (time/output.ts), discovery
// of `time-*` tasks (the compiler), and one end-to-end smoke run that compiles a tiny `time-*` task and executes it
// through the real runner (compile -> spawn node -> collect samples -> stat). It uses a small iteration count on
// purpose: it verifies the pipeline runs, it does not measure anything, so timing noise is irrelevant.

import { computeStats } from '@term/make/code/time/stats'
import { compileBenchmarks } from '@term/make/code/time/runner'
import { benchmark } from '@term/make/code/time/benchmark'
import { buildSuite, formatJson, fromSaved } from '@term/make/code/time/output'
import * as os from 'node:os'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

async function main(): Promise<void> {
  // the saved baseline keeps its snake_case keys, an on-disk format, though a result's fields are camelCase in memory
  // since time/stats is Term (2026-10-04); and a saved file reads back as the comparison reads it
  {
    const r = computeStats('disk', [10, 20, 30])
    const written = JSON.parse(formatJson(buildSuite([r]))) as { results: Record<string, unknown>[] }
    const keys = Object.keys(written.results[0]!).sort().join(',')
    ok(
      'the saved baseline is snake_case',
      keys === 'cv,iterations,max_ns,mean_ns,median_ns,min_ns,name,ops_per_sec,std_dev_ns,timings_ns',
      keys,
    )

    // read back as one side of a comparison (time/compare's `side`): the spread a `maybe`, the samples counted
    const back = fromSaved(written.results[0] as Parameters<typeof fromSaved>[0])
    ok(
      'a saved result reads back',
      back.meanNs === 20 && back.stdDevNs.form === 'some' && back.stdDevNs.value === r.stdDevNs && back.samples === 3,
      JSON.stringify(back),
    )
    const old = fromSaved({ name: 'old', mean_ns: 5 })
    ok('a pre-2026-10-04 baseline, the mean alone, reads back with no spread', old.meanNs === 5 && old.stdDevNs.form === 'none' && old.samples === 0, JSON.stringify(old))
  }

  // discovery finds zero-arg `time-*` tasks and respects the filter
  {
    const src = `task time-add\n  send back\n    call add\n      code 1\n      code 2\n\ntask time-mul\n  send back\n    call multiply\n      code 2\n      code 3\n\ntask helper\n  take n, like number\n  send back, read n\n`
    const all = compileBenchmarks({ text: src, file: 't.tree' })
    const names = all.benchmarks.map(b => b.name).sort()
    ok(
      'discovers both time-* tasks, skips the helper',
      names.length === 2 &&
        names[0] === 'time-add' &&
        names[1] === 'time-mul',
      JSON.stringify(names),
    )

    const filtered = compileBenchmarks({
      text: src,
      file: 't.tree',
      filter: 'add',
    })

    ok(
      'filter narrows to one benchmark',
      filtered.benchmarks.length === 1 &&
        filtered.benchmarks[0]!.name === 'time-add',
      JSON.stringify(filtered.benchmarks),
    )
  }

  // end-to-end smoke: the driver compiles, runs, and stats a real benchmark, then gates against a baseline
  {
    const src = `task time-noop\n  send back, code 1\n`
    const run = await benchmark({
      text: src,
      file: 'bench.tree',
      root: os.tmpdir(),
      warmup: 2,
      iterations: 5,
      baseline: { results: [fromSaved({ name: 'time-noop', mean_ns: 1e9 })] },
    })

    ok('driver produced one result', run.suite.results.length === 1)
    ok(
      'driver result is the named benchmark',
      run.suite.results[0]?.name === 'time-noop',
      JSON.stringify(run.suite.results[0]),
    )
    ok(
      'driver recorded the iteration count',
      run.suite.results[0]?.iterations === 5,
    )
    ok(
      'driver did not flag a regression vs a slow baseline',
      run.regressed === false,
    )
    ok('driver attached a comparison', run.comparison !== undefined)
  }

  console.log(`\ntime: ${pass} pass, ${fail} fail`)
}

void main()
