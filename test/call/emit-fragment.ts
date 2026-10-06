// `term make --emit wgsl` and `--emit hvm` (call/code/emit.ts, 2026-10-05): the numeric fragment emitted, and a
// construct outside it REFUSED, naming the construct and its place, with nothing written. Until then neither target had
// a command, and their emitters wrote a SEED-UNSUPPORTED marker into the output in the construct's place.
// Run: npx tsx test/call/emit-fragment.ts

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info.slice(0, 1200)}`)
  }
}

const LINE = join(dirname(fileURLToPath(import.meta.url)), '../../host/line.js')
const project = mkdtempSync(join(tmpdir(), 'term-emit-fragment-'))
mkdirSync(join(project, 'code'))
writeFileSync(join(project, 'deck.tree'), 'deck @probe/emit-fragment\nhead <Probe>\nmark <0.0.2>\nlink @term/base, mark <0.0.x>\n')

// inside both fragments: numbers, a branch, recursion
writeFileSync(
  join(project, 'code/fib.tree'),
  `task fib
  take n, like number
  like number
  fork test, is-below(n, 2)
    hold
      back n
    miss
      back add(fib(subtract(n, 1)), fib(subtract(n, 2)))
`,
)

// text, outside both
writeFileSync(
  join(project, 'code/greet.tree'),
  `task greet
  take n, like number
  like text
  back <hello {n}>
`,
)

const term = (...args: string[]) => spawnSync(process.execPath, [LINE, ...args], { cwd: project, encoding: 'utf8' })

for (const target of ['wgsl', 'hvm']) {
  const fib = term('make', '--emit', target, 'code/fib.tree')
  // the program, with no construct marked in place of code: a marker is `0 /* ... */` in WGSL and a header line in HVM
  const marked = /0 \/\*|SEED-UNSUPPORTED on/.test(fib.stdout)
  ok(`${target}: a numeric, recursive program emits`, fib.status === 0 && /fib/.test(fib.stdout) && !marked, `${fib.status} ${fib.stdout} ${fib.stderr}`)

  const greet = term('make', '--emit', target, 'code/greet.tree', '--out', `greet.${target}`)
  ok(
    `${target}: text is refused, naming the construct and its line, and nothing is written`,
    greet.status === 1 && /outside what (WGSL|HVM) lowers/.test(greet.stderr) && /greet\.tree:4/.test(greet.stderr) && !existsSync(join(project, `greet.${target}`)),
    `${greet.status} ${greet.stderr}`,
  )

  const run = term('make', '--emit', target, 'code/fib.tree', '--run')
  ok(`${target}: --run is refused as usage, the target is emitted as source`, run.status === 2 && /emitted as source/.test(run.stderr), `${run.status} ${run.stderr}`)
}

console.log(`\nemit-fragment: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
