// Benchmark harness tests. Run: npx tsx test/time/run.ts
// The pure pieces (stats, comparison, gating, discovery) are checked deterministically with synthetic samples. One
// end-to-end smoke run compiles a tiny `time-*` task and executes it through the real runner to prove the plumbing
// (compile -> spawn node -> collect samples -> stat). It uses a small iteration count on purpose: it verifies the
// pipeline runs, it does not measure anything, so timing noise is irrelevant.

import {
  computeStats,
  formatDuration,
} from '@term/make/code/time/stats'
import { compileBenchmarks } from '@term/make/code/time/runner'
import {
  compareResults,
  shouldFail,
  sideOf,
} from '@term/make/code/time/compare'
import { benchmark } from '@term/make/code/time/benchmark'
import { buildSuite, formatJson, fromSaved } from '@term/make/code/time/output'
import { formatTable } from '@term/make/code/time/table'
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
  // computeStats reduces raw samples to the right summary
  {
    const r = computeStats('s', [10, 20, 30, 40])
    ok('stats mean', r.meanNs === 25, String(r.meanNs))
    ok(
      'stats median (even count)',
      r.medianNs === 25,
      String(r.medianNs),
    )
    ok('stats min/max', r.minNs === 10 && r.maxNs === 40)
    ok('stats iterations', r.iterations === 4)
    ok('stats ops_per_sec', r.opsPerSec === 1e9 / 25)
  }

  // formatDuration picks the right unit
  {
    ok('duration ns', formatDuration(500) === '500.0ns')
    ok('duration us', formatDuration(2_000) === '2.00us')
    ok('duration ms', formatDuration(2_000_000) === '2.00ms')
    ok('duration s', formatDuration(2_000_000_000) === '2.00s')
  }

  // comparison classifies each benchmark vs the baseline and counts regressions / improvements
  {
    const current = [
      computeStats('slow', [200, 200, 200]), // was 100 -> +100% slower
      computeStats('fast', [50, 50, 50]), // was 100 -> -50% faster
      computeStats('flat', [100, 100, 100]), // was 100 -> same
      computeStats('fresh', [10, 10, 10]), // not in baseline -> new
    ]

    const baseline = [
      fromSaved({ name: 'slow', mean_ns: 100 }),
      fromSaved({ name: 'fast', mean_ns: 100 }),
      fromSaved({ name: 'flat', mean_ns: 100 }),
    ]

    const cmp = compareResults(current, baseline)
    const byName = new Map(cmp.entries.map(e => [e.name, e.status]))
    ok('compare marks regression', byName.get('slow') === 'slower')
    ok('compare marks improvement', byName.get('fast') === 'faster')
    ok('compare marks unchanged', byName.get('flat') === 'same')
    ok('compare marks new benchmark', byName.get('fresh') === 'new')
    ok(
      'compare counts',
      cmp.regressions === 1 && cmp.improvements === 1,
    )

    // the CI gate fires only when a regression exceeds the threshold
    ok(
      'gate fails on a regression past threshold',
      shouldFail(cmp, 10) === true,
    )
    ok(
      'gate passes when the threshold is generous',
      shouldFail(cmp, 500) === false,
    )
  }

  // a difference the samples' own spread explains is the same, however far past 5% the means are; one outside it is
  // a change (guides: commands/time, 2026-10-04)
  {
    const noisy = computeStats('noisy', [60, 140, 80, 120, 100, 110])
    const noisyBefore = computeStats('noisy', [50, 150, 70, 130, 90, 100])
    const steady = computeStats('steady', [110, 111, 109, 110, 110, 111])
    const steadyBefore = computeStats('steady', [100, 101, 99, 100, 100, 101])

    const cmp = compareResults([noisy, steady], [sideOf(noisyBefore), sideOf(steadyBefore)])
    const byName = new Map(cmp.entries.map(e => [e.name, e]))

    ok('a 10% change inside the spread is the same', byName.get('noisy')?.status === 'same', JSON.stringify(byName.get('noisy')))
    ok('a 10% change outside it is slower', byName.get('steady')?.status === 'slower', JSON.stringify(byName.get('steady')))
  }

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

  // the table: operations per second grouped by thousands with commas on every machine (time/table.tree; the original
  // grouped by the machine's locale), a name past the 9-column floor widening its column
  {
    const r = { ...computeStats('time-a-long-benchmark', [500]), opsPerSec: 1234567.5, cv: 0.123 }
    const lines = formatTable([r]).split('\n')
    ok('the table has a header, a rule and a row', lines.length === 3, JSON.stringify(lines))
    ok('operations per second are grouped by thousands', lines[2]!.includes('1,234,568'), lines[2])
    ok('the name column widens past nine', lines[1]!.startsWith(`  ${'-'.repeat('time-a-long-benchmark'.length)}  `), lines[1])
    ok('the row reads its mean and CV', lines[2]!.includes('500.0ns') && lines[2]!.endsWith('12.3%'), lines[2])
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
