// Benchmark harness tests. Run: npx tsx test/time/run.ts
// The pure pieces (stats, comparison, gating, discovery) are checked deterministically with synthetic samples. One
// end-to-end smoke run compiles a tiny `time-*` task and executes it through the real runner to prove the plumbing
// (compile -> spawn node -> collect samples -> stat). It uses a small iteration count on purpose: it verifies the
// pipeline runs, it does not measure anything, so timing noise is irrelevant.

import { computeStats, formatDuration } from '@cluesurf/make/code/time/stats'
import { compileBenchmarks } from '@cluesurf/make/code/time/runner'
import {
  compareResults,
  shouldFail,
} from '@cluesurf/make/code/time/compare'
import { benchmark } from '@cluesurf/make/code/time/benchmark'
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
    ok('stats mean', r.mean_ns === 25, String(r.mean_ns))
    ok('stats median (even count)', r.median_ns === 25, String(r.median_ns))
    ok('stats min/max', r.min_ns === 10 && r.max_ns === 40)
    ok('stats iterations', r.iterations === 4)
    ok('stats ops_per_sec', r.ops_per_sec === 1e9 / 25)
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
    const baseline = {
      results: [
        { name: 'slow', mean_ns: 100 },
        { name: 'fast', mean_ns: 100 },
        { name: 'flat', mean_ns: 100 },
      ],
    }
    const cmp = compareResults({ current, baseline })
    const byName = new Map(cmp.entries.map(e => [e.name, e.status]))
    ok('compare marks regression', byName.get('slow') === 'slower')
    ok('compare marks improvement', byName.get('fast') === 'faster')
    ok('compare marks unchanged', byName.get('flat') === 'same')
    ok('compare marks new benchmark', byName.get('fresh') === 'new')
    ok('compare counts', cmp.regressions === 1 && cmp.improvements === 1)

    // the CI gate fires only when a regression exceeds the threshold
    ok(
      'gate fails on a regression past threshold',
      shouldFail({ result: cmp, maxRegressionPct: 10 }) === true,
    )
    ok(
      'gate passes when the threshold is generous',
      shouldFail({ result: cmp, maxRegressionPct: 500 }) === false,
    )
  }

  // discovery finds zero-arg `time-*` tasks and respects the filter
  {
    const src = `task time-add\n  send back\n    call add\n      code 1\n      code 2\n\ntask time-mul\n  send back\n    call multiply\n      code 2\n      code 3\n\ntask helper\n  take n, like number\n  send back, read n\n`
    const all = compileBenchmarks({ text: src, file: 't.tree' })
    const names = all.benchmarks.map(b => b.name).sort()
    ok(
      'discovers both time-* tasks, skips the helper',
      names.length === 2 && names[0] === 'time-add' && names[1] === 'time-mul',
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
      baseline: { results: [{ name: 'time-noop', mean_ns: 1e9 }] },
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
