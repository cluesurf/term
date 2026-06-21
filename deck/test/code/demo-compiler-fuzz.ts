/**
 * Fuzz the live Seed compiler. Run from the seed install root:
 *   npx tsx deck/test/code/demo-compiler-fuzz.ts
 *
 * Structure-aware mutation of valid `.tree` sources, fed to `compile`.
 * The oracle: the compiler must always return a result (ok or
 * diagnostics) and never throw. Any throw is a real compiler bug; the
 * fuzzer prints the minimized input that triggers it.
 *
 * The demo passes when the fuzzer RAN and classified every input. If it
 * finds crashes, they are listed as findings to fix (not test noise).
 */

import { fuzzCompiler, minimizeCrash } from './compiler-fuzz'

// a small seed corpus of valid, self-contained Seed programs
const CORPUS = [
  `task answer
  like number
  send back
    mark 42
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
      mark 1
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

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

const report = fuzzCompiler({ corpus: CORPUS, runs: 3000, seed: 7 })

console.log(`  ran ${report.runs} mutated inputs`)
console.log(`  distinct diagnostic codes exercised: ${report.codesSeen.length} [${report.codesSeen.join(', ')}]`)
console.log(`  corpus grew by ${report.corpusGrew} coverage-novel inputs`)
console.log(`  crashes found: ${report.crashes.length}`)

ok('fuzzer ran the full budget', report.runs === 3000)
ok('fuzzing exercised multiple compiler diagnostics (real coverage)', report.codesSeen.length >= 3)
ok('coverage-guided corpus grew', report.corpusGrew >= 1)

if (report.crashes.length > 0) {
  console.log(`\n  --- ${report.crashes.length} CRASH(es) FOUND (compiler bugs to fix) ---`)
  // report up to 3 minimized, de-duplicated by error head
  const seen = new Set<string>()
  let shown = 0
  for (const crash of report.crashes) {
    const head = crash.error.split('\n')[0] ?? ''
    if (seen.has(head)) continue
    seen.add(head)
    if (shown++ >= 3) break
    const minimal = minimizeCrash(crash.input)
    console.log(`\n  error: ${head}`)
    console.log('  minimal input:')
    console.log(minimal.split('\n').map(l => '    | ' + l).join('\n'))
  }
  console.log(`\n  (${seen.size} distinct crash signature(s))`)
} else {
  ok('no compiler crashes in this run', true)
}

console.log(`\nseed-verify compiler-fuzz demo: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
