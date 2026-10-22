// Termination across two files, merged (`compile`) and separate (`compileSeparate`): both builds reach the same
// verdict (term-term-gates-0005). The merged build of deck/make/code/check/elaborating-terms.tree warned that 8 tasks
// were in a mutual-recursion cycle and the separate one did not. The merged one was wrong: judging.tree's `quote` binds
// `link body` in a match arm, the walk's `local-names` does not list an arm's names, and the merged program held a TASK
// named `body` (elaborating-terms.tree's), so the local read looked like a read of that task as a value and closed a
// cycle through it. A name the resolver bound to a local or a parameter now names no task (check/termination.tree
// `locally-bound`). A cycle that does cross the two files (a task handed to the other file as a value, which calls it)
// is still reported by both, as is a mutual recursion between two files that load each other.
// Run: npx tsx test/compile/termination-across-units.ts

import { compile } from '@term/make/code/compile/compile'
import { compileSeparate } from '@term/make/code/compile/separate'
import { CompileCache } from '@term/make/code/compile/cache'
import type { Resolver } from '@term/make/code/compile/load'

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

type Built = { ok: boolean; warnings?: { message: string; file?: string }[]; diagnostics?: { message: string }[] }

const slug = (file: string): string => `./${file.replace(/\.tree$/, '').replace(/\W/g, '_')}.mjs`

const resolverOf = (files: Record<string, string>): Resolver => path => {
  const name = path.replace(/^\.\//, '')
  const text = files[name]

  return text === undefined ? undefined : { file: `${name}.tree`, text }
}

// the entry's own cycle warnings, in each build
function cycles(entry: string, files: Record<string, string>): { merged: string[]; separate: string[] } {
  const resolve = resolverOf(files)
  const own = (r: Built): string[] => {
    if (!r.ok) {
      return [`REFUSED ${(r.diagnostics ?? []).map(d => d.message.slice(0, 160)).join(' | ')}`]
    }

    return (r.warnings ?? [])
      .filter(w => w.file === 'entry.tree' && /cycle|calls itself/.test(w.message))
      .map(w => w.message)
      .sort()
  }
  const merged = compile({ file: 'entry.tree', text: entry }, { resolve, cache: new CompileCache() }) as Built
  const separate = compileSeparate(
    { file: 'entry.tree', text: entry },
    { resolve, cache: new CompileCache(), modules: slug },
  ) as Built

  return { merged: own(merged), separate: own(separate) }
}

// A LOCAL NAMED LIKE A TASK OF ANOTHER FILE. The model's `walk-it` binds `body` in an arm and reads it, the entry
// defines a task `body` that calls `walk-it`. No task reaches itself
const SHAPE = `form shape
  case leaf
  case node
    link body, like number

task walk-it
  take s, like shape
  like number
  sift s
    case leaf
      send back, 0
    case node
      link body
      send back, add(body, 1)
`

const LOCAL_ENTRY = `load ./shape
  find shape
  find walk-it

task body
  take s, like shape
  like number
  send back, walk-it(s)
`

const local = cycles(LOCAL_ENTRY, { shape: SHAPE })
ok('a local named like a task closes no cycle, merged', local.merged.length === 0, JSON.stringify(local.merged))
ok('a local named like a task closes no cycle, separate', local.separate.length === 0, JSON.stringify(local.separate))

// A REAL CYCLE THROUGH ANOTHER FILE: the entry hands `again` to the model's `apply`, which calls it, and `again` calls
// `apply` with itself. Nothing descends: both builds must say so
const APPLY = `task apply
  take f
    like task
      take n, like number
      like number
  take n, like number
  like number
  send back, f(n)
`

const VALUE_ENTRY = `load ./apply
  find apply

task again
  take n, like number
  like number
  send back, apply(again, n)
`

const value = cycles(VALUE_ENTRY, { apply: APPLY })
ok('a cycle through a task handed to another file is reported, merged', value.merged.length > 0, JSON.stringify(value.merged))
ok('a cycle through a task handed to another file is reported, separate', value.separate.length > 0, JSON.stringify(value.separate))
ok('both builds say the same of it', JSON.stringify(value.merged) === JSON.stringify(value.separate), JSON.stringify(value))

// A MUTUAL RECURSION BETWEEN TWO FILES THAT LOAD EACH OTHER (one unit of two files), with no descent
const PING = `load ./entry
  find pong

task ping
  take n, like number
  like number
  send back, pong(n)
`

const PONG_ENTRY = `load ./ping
  find ping

task pong
  take n, like number
  like number
  send back, ping(n)
`

const mutual = cycles(PONG_ENTRY, { ping: PING, entry: PONG_ENTRY })
ok('a mutual recursion across two files is reported, merged', mutual.merged.some(m => /mutual-recursion cycle/.test(m)), JSON.stringify(mutual.merged))
ok('a mutual recursion across two files is reported, separate', mutual.separate.some(m => /mutual-recursion cycle/.test(m)), JSON.stringify(mutual.separate))
ok('both builds say the same of it', JSON.stringify(mutual.merged) === JSON.stringify(mutual.separate), JSON.stringify(mutual))

console.log(`\ntermination-across-units: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
