// Purity and a list a task makes for itself (check/facts.ts, `writes` and `madeHere`, optimize-0006, 2026-10-02).
//
// Writing into a list or map is invisible to the caller only when the task MADE that list or map: then no other name
// can hold it. Before this, every `push` made a task impure, so a task that built a list of its own and returned it
// was impure, and so was every task that called it, which is most of the stdlib. Both directions are held here,
// because widening purity is how a false proof gets in: the kernel treats a pure task as a definition.
// Run: npx tsx test/check/purity-local.ts

import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import { resolve as resolveNames } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { pureFunctions } from '@term/make/code/check/facts'
import { collectModules } from '@term/make/code/compile/load'
import type { Source } from '@term/make/code/compile/load'
import type { Program } from '@term/make/code/compile/node'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

let pass = 0
let fail = 0

function ok(name: string, holds: boolean): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}`)
  }
}

const base = join(import.meta.dirname, '../../deck/base')
const stdlib = (path: string): Source | undefined => {
  const file = join(base, `${path.replace(/^@term\/base\//, '')}.tree`)

  return /^@term\/base\//.test(path) && existsSync(file) ? { file, text: readFileSync(file, 'utf8') } : undefined
}

function programOf(text: string): Program {
  const program: Program = []

  for (const unit of collectModules({ file: 'main.tree', text }, stdlib).sources) {
    const parsed = parse(unit)

    if (!parsed.ok) {
      throw new Error(`parse failed: ${unit.file}`)
    }

    const built = mill(parsed.tree, unit.file)

    if (!built.ok) {
      throw new Error(`mill failed: ${unit.file}`)
    }

    program.push(...built.program)
  }

  resolveNames(program, 'main.tree')
  check(program, 'main.tree')

  return program
}

const program = programOf(`load @term/base/code/list
  find list

# builds a list of its own and returns it: nobody else can see the pushes
task fresh
  take n, like number
  like list, like number
  save out
    make list
  call push
    bind list, read out
    bind item, read n
  send back, read out

# calls it: still pure
task calls-fresh
  like number
  host made
    call fresh
      code 3
  send back
    call size
      read made

# pushes onto the list it was HANDED: the caller sees the change
task into-parameter
  take xs, like list, like number
  like number
  call push
    bind list, read xs
    bind item, code 1
  send back, code 0

# a second name for the parameter: the same list, so the same change
task through-alias
  take xs, like list, like number
  like number
  save ys, read xs
  call push
    bind list, read ys
    bind item, code 1
  send back, code 0

# made here, then rebound to the parameter: no longer only its own
task rebound
  take xs, like list, like number
  like number
  save ys
    make list
  save ys, read xs
  call push
    bind list, read ys
    bind item, code 1
  send back, code 0

# hands its own parameter on to a task that writes into it: writes through it in turn
task passes-parameter
  take xs, like list, like number
  like number
  send back
    call into-parameter
      read xs

# hands a list it made to the task that writes: that write is its own business
task passes-fresh
  like number
  save mine
    make list
  send back
    call into-parameter
      read mine

# reads the list it was handed: reading changes nothing
task reads-parameter
  take xs, like list, like number
  like number
  send back
    call size
      read xs
`)

const pure = pureFunctions(program)

ok('a task that builds a list of its own and returns it is pure', pure.has('fresh'))
ok('a task calling it is pure', pure.has('calls-fresh'))
ok('a task that pushes onto its parameter is NOT pure', !pure.has('into-parameter'))
ok('a task that pushes through a second name for its parameter is NOT pure', !pure.has('through-alias'))
ok('a local made fresh and then rebound to the parameter is NOT its own', !pure.has('rebound'))
ok('a task handing its parameter to one that writes into it is NOT pure', !pure.has('passes-parameter'))
ok('a task handing a list it made to one that writes into it is pure', pure.has('passes-fresh'))
ok('a task that only reads its parameter is pure', pure.has('reads-parameter'))
ok("the stdlib's own push, which writes through `self`, is NOT pure", !pure.has('list_push'))

console.log(`\npurity-local: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
