// A call that mixes arguments in parentheses with argument lines under it takes its arguments in WRITTEN order: the
// parenthesized ones first, then each line below in order (item term-self-host-001-0303, decision 042 Open). The mill
// orders a call's arguments by each capture's `at`, its index in the group it was enumerated from, and the
// parenthesized arguments sit in the callee's own group `f(...)`, the lines in the call's group, so `at` alone sorted
// `call f(a, b, 7)` over a `9` line as a b 9 7 (2 where the program says -2). A capture enumerated inside the callee's
// parentheses now carries `within`, the `at` of that group, and the order reads both (compile/mill-running.tree,
// compile/minting-values.tree `at-or`).
//
// Two legs: the mill's own answer (compile/mint-bridge.ts `millByGrammar`) for every shape, and the program run on
// TypeScript, Rust, Swift and Kotlin (a backend whose toolchain is absent is skipped, as the gate's suites do).
// MIXED_ONLY=typescript|rust|swift|kotlin runs one backend.
// Run: npx tsx test/compile/mixed-call-order.ts

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import type { RootNode } from '@term/make/code/parser/narrow'
import { expandTemplates } from '@term/make/code/compile/template'
import { expandScopes } from '@term/make/code/compile/scope'
import { millByGrammar } from '@term/make/code/compile/mint-bridge'
import { projectResolver } from '@term/call/code/make'
import { runOn } from './shared/run-on'
import type { Backend } from './shared/run-on'

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

// ---- the mill: each call to `f`, its arguments as written, and the names a named argument carries ----

type Shape = {
  name: string
  text: string
  args: string
  names?: string
  lean?: boolean
}

const SHAPES: Shape[] = [
  {
    name: 'three in parentheses, one line',
    text: 'task main\n  take a, like number\n  take b, like number\n  send back\n    call f(read(a), read(b), code(7))\n      code 9\n',
    args: 'a b 7 9',
  },
  {
    name: 'four in parentheses, one line',
    text: 'task main\n  take a, like number\n  take b, like number\n  send back\n    call f(read(a), read(b), code(7), code(8))\n      code 9\n',
    args: 'a b 7 8 9',
  },
  {
    name: 'two in parentheses, two lines',
    text: 'task main\n  take a, like number\n  take b, like number\n  send back\n    call f(read(a), read(b))\n      read b\n      read a\n',
    args: 'a b b a',
  },
  {
    name: 'two in parentheses, two bind lines',
    text: 'task main\n  take a, like number\n  take b, like number\n  send back\n    call f(read(a), read(b))\n      bind x, code 1\n      bind y, code 2\n',
    args: 'a b 1 2',
    names: ',,x,y',
  },
  {
    name: 'three in parentheses, a bind line',
    text: 'task main\n  take a, like number\n  take b, like number\n  send back\n    call f(read(a), read(b), read(a))\n      bind x, code 1\n',
    args: 'a b a 1',
    names: ',,,x',
  },
  {
    name: 'a line, a bind line and a line',
    text: 'task main\n  take a, like number\n  send back\n    call f(read(a), code(7))\n      code 9\n      bind x, code 1\n      code 3\n',
    args: 'a 7 9 1 3',
    names: ',,,x,',
  },
  {
    name: 'tick with parentheses and a line',
    text: 'task main\n  take a, like number\n  tick f(read(a), code(7))\n    code 9\n',
    args: 'a 7 9',
  },
  {
    name: 'lean: parentheses and lines',
    text: 'task main\n  take a, like number\n  take b, like number\n  back\n    call f(a, b, 7)\n      9\n      b\n',
    args: 'a b 7 9 b',
    lean: true,
  },
  {
    name: 'only parentheses (unchanged)',
    text: 'task main\n  take a, like number\n  send back\n    call f(read(a), code(7), code(9))\n',
    args: 'a 7 9',
  },
  {
    name: 'only lines (unchanged)',
    text: 'task main\n  take a, like number\n  send back\n    call f\n      read a\n      bind x, code 1\n      code 9\n',
    args: 'a 1 9',
    names: ',x,',
  },
]

function label(arg: Record<string, unknown>): string {
  return String(arg.name ?? arg.value ?? arg.form)
}

function callsOf(value: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    value.forEach(one => callsOf(one, out))
    return
  }
  if (value === null || typeof value !== 'object') {
    return
  }
  const record = value as Record<string, unknown>
  if (
    record.form === 'call' &&
    (record.callee as { name?: string })?.name === 'f'
  ) {
    out.push(record)
  }
  for (const [key, child] of Object.entries(record)) {
    if (key !== 'span') {
      callsOf(child, out)
    }
  }
}

for (const shape of SHAPES) {
  const file = `/gen/mixed-${pass + fail}.tree`
  const parsed = parse({ file, text: shape.text })
  if (!parsed.ok) {
    ok(`mill: ${shape.name}`, false, 'parse failed')
    continue
  }
  const expanded = expandScopes(
    expandTemplates(parsed.tree) as never,
    file,
  )
  const milled = millByGrammar(
    expanded.tree as RootNode,
    file,
    undefined,
    undefined,
    shape.lean === true,
  )
  const calls: Record<string, unknown>[] = []
  if (milled.ok) {
    callsOf(milled.program, calls)
  }
  const call = calls[0]
  const args = call
    ? (call.args as Record<string, unknown>[]).map(label).join(' ')
    : ''
  ok(
    `mill: ${shape.name}: arguments in written order`,
    args === shape.args,
    `got ${JSON.stringify(args)}, want ${JSON.stringify(shape.args)}`,
  )
  if (shape.names !== undefined) {
    const names = ((call?.names as string[] | undefined) ?? []).join(
      ',',
    )
    ok(
      `mill: ${shape.name}: names beside their arguments`,
      names === shape.names,
      `got ${JSON.stringify(names)}`,
    )
  }
}

// ---- the program, on every backend ----

const PROGRAM = `task five
  take a, like number
  take b, like number
  take c, like number
  take d, like number
  take e, like number
  like text
  send back, text <{a} {b} {c} {d} {e}>

task four
  take a, like number
  take b, like number
  take c, like number
  take d, like number
  like number
  send back, call subtract(read(c), read(d))

task named
  take a, like number
  take b, like number
  take y, like number
  like text
  send back, text <{a} {b} {y}>

task run
  like text
  save all
    call five(code(1), code(2), code(7), code(8))
      code 9
  save difference
    call four(code(1), code(2), code(7))
      code 9
  save lines
    call five(code(1))
      code 2
      code 3
      code 4
      code 5
  save by-name
    call named(code(1))
      bind y, code 5
      code 2
  send back, text <{all}|{difference}|{lines}|{by-name}>
`

const WANT = '1 2 7 8 9|-2|1 2 3 4 5|1 2 5'
const dir = mkdtempSync(join(tmpdir(), 'term-mixed-call-order-'))
const only = process.env.MIXED_ONLY ?? ''

for (const backend of (
  ['typescript', 'rust', 'swift', 'kotlin'] as Backend[]
).filter(b => !only || b === only)) {
  const ran = runOn({
    backend,
    program: PROGRAM,
    resolve: env => projectResolver(process.cwd(), env),
    dir,
    name: 'mixed',
  })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(
    `${backend}: compiles, builds and runs`,
    ran.form === 'ran',
    ran.form === 'failed' ? `${ran.stage}: ${ran.reason}` : '',
  )

  if (ran.form === 'ran') {
    ok(
      `${backend}: every mixed call takes its arguments in written order`,
      ran.output === WANT,
      `got ${JSON.stringify(ran.output)}, want ${JSON.stringify(WANT)}`,
    )
  }
}

console.log(`\nmixed-call-order: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
