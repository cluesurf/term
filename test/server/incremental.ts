// Incremental analyzer test (Tier 2 #1). The editor front-end on the query-engine compiler: it produces the same
// diagnostics as the whole-program `analyze`, but re-checks only the function that changed. Run: npx tsx test/server/incremental.ts

import { IncrementalAnalyzer } from '@/code/server/incremental'
import { analyze } from '@/code/server/analyze'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}`) } else { fail++; console.log(`FAIL  ${name}  ${info}`) }
}

const helperOk = `task helper\n  take n, like number\n  like number\n  send back\n    read n\n`
const callerSrc = `task caller\n  like number\n  send back\n    call helper\n      mark 5\n`
const otherSrc = `task other\n  like number\n  send back\n    mark 0\n`
const withHelper = (helper: string): string => `${helper}\n${callerSrc}\n${otherSrc}`

// 1. a clean program: no diagnostics, a typed program is produced
{
  const analyzer = new IncrementalAnalyzer()
  const result = analyzer.analyze({ file: 'm.tree', text: withHelper(helperOk) })
  ok('clean program: no diagnostics', result.diagnostics.length === 0, JSON.stringify(result.diagnostics))
  ok('clean program: produces a typed program', !!result.program && result.program.length === 3)
}

// 2. matches the whole-program analyzer on a clean program AND on a real type error
{
  const clean = withHelper(helperOk)
  const broken = withHelper(`task helper\n  take n, like number\n  like number\n  send back\n    text <oops>\n`)
  for (const [label, text] of [['clean', clean], ['type error', broken]] as const) {
    const whole = analyze({ file: 'm.tree', text })
    const incr = new IncrementalAnalyzer().analyze({ file: 'm.tree', text })
    const codes = (ds: Array<{ code: number }>) => ds.map(d => d.code).sort().join(',')
    ok(`incremental diagnostics match whole-program (${label})`, codes(incr.diagnostics) === codes(whole.diagnostics), `incr=${codes(incr.diagnostics)} whole=${codes(whole.diagnostics)}`)
  }
}

// 3. incrementality: editing one function re-checks only it
{
  const analyzer = new IncrementalAnalyzer()
  analyzer.analyze({ file: 'm.tree', text: withHelper(helperOk) })
  const db = analyzer.compiler.db
  const callerTyped = db.runs('typed:caller')
  const otherTyped = db.runs('typed:other')

  // edit ONLY helper's body
  analyzer.analyze({ file: 'm.tree', text: withHelper(`task helper\n  take n, like number\n  like number\n  send back\n    call multiply\n      read n\n      mark 2\n`) })
  ok('editing helper does NOT re-type-check the caller', db.runs('typed:caller') === callerTyped)
  ok('editing helper does NOT re-type-check the unrelated function', db.runs('typed:other') === otherTyped)
  ok('editing helper DOES re-type-check helper', db.runs('typed:helper') >= 2)

  // a no-op re-analyze recomputes nothing new
  const before = db.recomputes
  analyzer.analyze({ file: 'm.tree', text: withHelper(`task helper\n  take n, like number\n  like number\n  send back\n    call multiply\n      read n\n      mark 2\n`) })
  ok('a no-op re-analyze does no extra work', db.recomputes === before, `delta ${db.recomputes - before}`)
}

console.log(`\nserver/incremental: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
