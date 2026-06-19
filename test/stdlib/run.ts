// Stdlib tests: compile real base.tree modules with this compiler (via the module loader) and RUN the emitted
// TypeScript, asserting the pure logic. This proves the stdlib in deck/base.tree/code/ parses, type-checks, and
// runs. Run: npx tsx test/stdlib/run.ts

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compile } from '@/code/compile/compile'
import type { Source } from '@/code/compile/load'
import { render } from '@/code/parser/diagnostic'

const here = dirname(fileURLToPath(import.meta.url))
const baseTree = join(here, '..', '..', '..', 'base.tree') // deck/seed/deck/base.tree

// resolve `@cluesurf/base/code/<path>` to the stdlib .tree file on disk
function resolveStdlib(importPath: string): Source | undefined {
  const prefix = '@cluesurf/base/'
  if (!importPath.startsWith(prefix)) return undefined
  const file = join(baseTree, `${importPath.slice(prefix.length)}.tree`)
  if (!existsSync(file)) return undefined
  return { file, text: readFileSync(file, 'utf8') }
}

let pass = 0
let fail = 0
function expect(name: string, got: unknown, want: unknown): void {
  if (got === want) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)
  }
}

async function loadProgram(source: string): Promise<Record<string, (...a: Array<unknown>) => unknown>> {
  const result = compile({ file: 'main.tree', text: source }, { resolve: resolveStdlib })
  if (!result.ok) {
    for (const d of result.diagnostics) console.log(render(d, source.split('\n'), false))
    throw new Error('compile failed')
  }
  const dir = mkdtempSync(join(tmpdir(), 'seed-stdlib-'))
  const file = join(dir, 'module.ts')
  writeFileSync(file, result.typescript)
  return (await import(pathToFileURL(file).href)) as Record<string, (...a: Array<unknown>) => unknown>
}

// a program that loads the real base.tree maybe and exercises it
const MAYBE = `load @cluesurf/base/code/maybe
  find maybe

task unwrap-present
  like number
  back
    call unwrap-or
      make some
        bind value, mark 42
      mark 0

task unwrap-absent
  like number
  back
    call unwrap-or
      make none
      mark 7

task present
  like boolean
  back
    call is-some
      make some
        bind value, mark 1

task absent
  like boolean
  back
    call is-some
      make none

task map-add-one
  like number
  back
    call unwrap-or
      call map
        make some
          bind value, mark 41
        increment
      mark 0

task increment
  take n, like number
  like number
  back
    call add
      loan n
      mark 1
`

const RESULT = `load @cluesurf/base/code/result
  find result

task ok-value
  like number
  back
    call unwrap-or
      make okay
        bind value, mark 5
      mark 0

task err-default
  like number
  back
    call unwrap-or
      make error
        bind value, mark 99
      mark 0

task okay-check
  like boolean
  back
    call is-okay
      make okay
        bind value, mark 1
`

const PAIR = `load @cluesurf/base/code/pair
  find pair

task first-of
  like number
  back
    call get-first
      make pair
        bind first, mark 3
        bind second, mark 4

task second-after-swap
  like number
  back
    call get-second
      call swap
        make pair
          bind first, mark 3
          bind second, mark 4
`

const BOOLEAN = `load @cluesurf/base/code/boolean
  find boolean

task negate-true
  like boolean
  back
    call not
      wave true

task negate-false
  like boolean
  back
    call not
      wave false
`

// dock: a native module binding (FFI). `node:path` is pure + deterministic, so we can run it.
const DOCK = `dock load
  load <node:path>, name pathmod

task base-name
  like text
  back
    call pathmod/basename
      text </a/b/file.txt>
`

// both maybe and result loaded together: they each define `unwrap-or`/`map`, so this only works if the bare call
// dispatches on the receiver's form (selective find / receiver dispatch).
const COMBINED = `load @cluesurf/base/code/maybe
  find maybe

load @cluesurf/base/code/result
  find result

task from-maybe
  like number
  back
    call unwrap-or
      make some
        bind value, mark 11
      mark 0

task from-result
  like number
  back
    call unwrap-or
      make error
        bind value, mark 1
      mark 22
`

// the list type: native-array-backed methods, dispatched on the array receiver
const LIST = `load @cluesurf/base/code/list
  find list

task first-of
  like number
  back
    call unwrap-or
      call first
        make list
          mark 10
          mark 20
      mark 0

task last-of
  like number
  back
    call unwrap-or
      call last
        make list
          mark 10
          mark 20
          mark 30
      mark 0

task first-empty
  like number
  back
    call unwrap-or
      call first
        make list
      mark 99

task size-of
  like number
  back
    call size
      make list
        mark 1
        mark 2
        mark 3

task has-it
  like boolean
  back
    call contains
      make list
        mark 5
        mark 6
      mark 6

task get-second
  like number
  back
    call get
      make list
        mark 7
        mark 8
        mark 9
      mark 1

task join-them
  like text
  back
    call join
      make list
        mark 1
        mark 2
        mark 3
      text <->

task size-after-reverse
  like number
  back
    call size
      call reverse
        make list
          mark 1
          mark 2

task double
  take n, like number
  like number
  back
    call multiply
      read n
      mark 2

task size-after-map
  like number
  back
    call size
      call map
        make list
          mark 1
          mark 2
          mark 3
          mark 4
        read double

task add-two
  take a, like number
  take b, like number
  like number
  back
    call add
      read a
      read b

task sum-of
  like number
  back
    call reduce
      make list
        mark 1
        mark 2
        mark 3
      read add-two
      mark 0
`

// the combinators added to maybe / result / pair (and-then, or-else, filter, get-or-else, unwrap, map-error, ...)
const COMBINATORS = `load @cluesurf/base/code/maybe
  find maybe

load @cluesurf/base/code/result
  find result

load @cluesurf/base/code/pair
  find pair

task double-maybe
  take n, like number
  like maybe
  send back
    make some
      bind value
        call multiply
          read n
          mark 2

task is-even
  take n, like number
  like boolean
  send back
    call is-equal
      call modulo
        read n
        mark 2
      mark 0

task nine
  like number
  send back, mark 9

task to-nine
  take n, like number
  like number
  send back, mark 9

task and-then-some
  like number
  send back
    call unwrap-or
      call and-then
        make some
          bind value, mark 5
        read double-maybe
      mark 0

task or-else-none
  like number
  send back
    call unwrap-or
      call or-else
        make none
        make some
          bind value, mark 7
      mark 0

task filter-keep
  like number
  send back
    call unwrap-or
      call filter
        make some
          bind value, mark 4
        read is-even
      mark 0

task filter-drop
  like number
  send back
    call unwrap-or
      call filter
        make some
          bind value, mark 3
        read is-even
      mark 99

task get-or-else-none
  like number
  send back
    call get-or-else
      make none
      read nine

task unwrap-some
  like number
  send back
    call unwrap
      make some
        bind value, mark 8

task double-okay
  take n, like number
  like result
  send back
    make okay
      bind value
        call multiply
          read n
          mark 2

task and-then-okay
  like number
  send back
    call unwrap-or
      call and-then
        make okay
          bind value, mark 6
        read double-okay
      mark 0

task map-second-pair
  like number
  send back
    call get-second
      call map-second
        make pair
          bind first, mark 1
          bind second, mark 10
        read to-nine
`

// the hash (map) type, backed by the native map
const HASH = `load @cluesurf/base/code/hash
  find hash

task set-and-get
  like number
  save m
    make find
  save m
    call set
      read m
      text <a>
      mark 10
  send back
    call unwrap-or
      call get
        read m
        text <a>
      mark 0

task get-missing
  like number
  save m
    make find
  send back
    call unwrap-or
      call get
        read m
        text <nope>
      mark 99

task has-key
  like boolean
  save m
    make find
  save m
    call set
      read m
      text <x>
      mark 1
  send back
    call has
      read m
      text <x>

task entry-count
  like number
  save m
    make find
  save m
    call set
      read m
      text <a>
      mark 1
  save m
    call set
      read m
      text <b>
      mark 2
  send back
    call size
      read m
`

// the range type
const RANGE = `load @cluesurf/base/code/range
  find range

task range-length
  like number
  back
    call length
      make range
        bind start, mark 0
        bind end, mark 10
        bind step, mark 2

task range-has
  like boolean
  back
    call contains
      make range
        bind start, mark 0
        bind end, mark 10
        bind step, mark 1
      mark 5

task range-excludes-end
  like boolean
  back
    call contains
      make range
        bind start, mark 0
        bind end, mark 10
        bind step, mark 1
      mark 10
`

async function main(): Promise<void> {
  const h = await loadProgram(HASH)
  expect('hash/set then get returns some of the value', h.setAndGet!(), 10)
  expect('hash/get on a missing key returns none', h.getMissing!(), 99)
  expect('hash/has finds a set key', h.hasKey!(), true)
  expect('hash/size counts entries', h.entryCount!(), 2)

  const rg = await loadProgram(RANGE)
  expect('range/length is (end-start)/step', rg.rangeLength!(), 5)
  expect('range/contains a value in bounds', rg.rangeHas!(), true)
  expect('range/contains excludes the end', rg.rangeExcludesEnd!(), false)

  const x = await loadProgram(COMBINATORS)
  expect('maybe/and-then chains a maybe-returning call', x.andThenSome!(), 10)
  expect('maybe/or-else falls back to the alternative maybe', x.orElseNone!(), 7)
  expect('maybe/filter keeps a passing value', x.filterKeep!(), 4)
  expect('maybe/filter drops a failing value', x.filterDrop!(), 99)
  expect('maybe/get-or-else calls the thunk on none', x.getOrElseNone!(), 9)
  expect('maybe/unwrap returns the some value', x.unwrapSome!(), 8)
  expect('result/and-then chains a result-returning call', x.andThenOkay!(), 12)
  expect('pair/map-second maps the second element', x.mapSecondPair!(), 9)

  const l = await loadProgram(LIST)
  expect('list/first returns some of the head', l.firstOf!(), 10)
  expect('list/last returns some of the tail', l.lastOf!(), 30)
  expect('list/first on empty returns none', l.firstEmpty!(), 99)
  expect('list/size counts elements', l.sizeOf!(), 3)
  expect('list/contains finds a member', l.hasIt!(), true)
  expect('list/get reads by index', l.getSecond!(), 8)
  expect('list/join joins with a separator', l.joinThem!(), '1-2-3')
  expect('list/reverse then size is unchanged', l.sizeAfterReverse!(), 2)
  expect('list/map then size is unchanged', l.sizeAfterMap!(), 4)
  expect('list/reduce sums the elements', l.sumOf!(), 6)

  const c = await loadProgram(COMBINED)
  expect('combined: maybe.unwrap-or dispatches to the maybe method', c.fromMaybe!(), 11)
  expect('combined: result.unwrap-or dispatches to the result method', c.fromResult!(), 22)

  const d = await loadProgram(DOCK)
  expect('dock: a native module call runs (path.basename)', d.baseName!(), 'file.txt')

  const b = await loadProgram(BOOLEAN)
  expect('boolean/not on true is false', b.negateTrue!(), false)
  expect('boolean/not on false is true', b.negateFalse!(), true)

  const m = await loadProgram(MAYBE)
  expect('maybe/unwrap-or on some returns the value', m.unwrapPresent!(), 42)
  expect('maybe/unwrap-or on none returns the fallback', m.unwrapAbsent!(), 7)
  expect('maybe/is-some on some is true', m.present!(), true)
  expect('maybe/is-some on none is false', m.absent!(), false)
  expect('maybe/map applies the function under some', m.mapAddOne!(), 42)

  const r = await loadProgram(RESULT)
  expect('result/unwrap-or on okay returns the value', r.okValue!(), 5)
  expect('result/unwrap-or on error returns the fallback', r.errDefault!(), 0)
  expect('result/is-okay on okay is true', r.okayCheck!(), true)

  const p = await loadProgram(PAIR)
  expect('pair/get-first reads the first', p.firstOf!(), 3)
  expect('pair/swap then get-second reads the original first', p.secondAfterSwap!(), 3)

  console.log(`\nstdlib: ${pass} pass, ${fail} fail`)
}

main()
