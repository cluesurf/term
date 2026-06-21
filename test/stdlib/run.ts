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
const baseTree = join(here, '..', '..', 'deck', 'base') // deck/seed/deck/base.tree

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
    console.log(
      `FAIL  ${name}  (got ${JSON.stringify(
        got,
      )}, want ${JSON.stringify(want)})`,
    )
  }
}

async function loadProgram(
  source: string,
): Promise<Record<string, (...a: Array<unknown>) => unknown>> {
  const result = compile(
    { file: 'main.tree', text: source },
    { resolve: resolveStdlib },
  )
  if (!result.ok) {
    for (const d of result.diagnostics)
      console.log(render(d, source.split('\n'), false))
    throw new Error('compile failed')
  }
  const dir = mkdtempSync(join(tmpdir(), 'seed-stdlib-'))
  const file = join(dir, 'module.ts')
  writeFileSync(file, result.typescript)
  return (await import(pathToFileURL(file).href)) as Record<
    string,
    (...a: Array<unknown>) => unknown
  >
}

// a program that loads the real base.tree maybe and exercises it
const MAYBE = `load @cluesurf/base/code/maybe
  find maybe

task unwrap-present
  like number
  send back
    call unwrap-or
      make some
        bind value, code 42
      code 0

task unwrap-absent
  like number
  send back
    call unwrap-or
      make none
      code 7

task present
  like boolean
  send back
    call is-some
      make some
        bind value, code 1

task absent
  like boolean
  send back
    call is-some
      make none

task map-add-one
  like number
  send back
    call unwrap-or
      call map
        make some
          bind value, code 41
        increment
      code 0

task increment
  take n, like number
  like number
  send back
    call add
      loan n
      code 1
`

const RESULT = `load @cluesurf/base/code/result
  find result

task ok-value
  like number
  send back
    call unwrap-or
      make okay
        bind value, code 5
      code 0

task err-default
  like number
  send back
    call unwrap-or
      make error
        bind value, code 99
      code 0

task okay-check
  like boolean
  send back
    call is-okay
      make okay
        bind value, code 1
`

const PAIR = `load @cluesurf/base/code/pair
  find pair

task first-of
  like number
  send back
    call get-first
      make pair
        bind first, code 3
        bind second, code 4

task second-after-swap
  like number
  send back
    call get-second
      call swap
        make pair
          bind first, code 3
          bind second, code 4
`

const BOOLEAN = `load @cluesurf/base/code/boolean
  find boolean

task negate-true
  like boolean
  send back
    call not
      wave true

task negate-false
  like boolean
  send back
    call not
      wave false
`

// dock: a native module binding (FFI). `node:path` is pure + deterministic, so we can run it.
const DOCK = `dock load
  load <node:path>, name pathmod

task base-name
  like text
  send back
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
  send back
    call unwrap-or
      make some
        bind value, code 11
      code 0

task from-result
  like number
  send back
    call unwrap-or
      make error
        bind value, code 1
      code 22
`

// the list type: native-array-backed methods, dispatched on the array receiver
const LIST = `load @cluesurf/base/code/list
  find list

task first-of
  like number
  send back
    call unwrap-or
      call first
        make list
          code 10
          code 20
      code 0

task last-of
  like number
  send back
    call unwrap-or
      call last
        make list
          code 10
          code 20
          code 30
      code 0

task first-empty
  like number
  send back
    call unwrap-or
      call first
        make list
      code 99

task size-of
  like number
  send back
    call size
      make list
        code 1
        code 2
        code 3

task has-it
  like boolean
  send back
    call contains
      make list
        code 5
        code 6
      code 6

task get-second
  like number
  send back
    call get
      make list
        code 7
        code 8
        code 9
      code 1

task join-them
  like text
  send back
    call join
      make list
        code 1
        code 2
        code 3
      text <->

task size-after-reverse
  like number
  send back
    call size
      call reverse
        make list
          code 1
          code 2

task double
  take n, like number
  like number
  send back
    call multiply
      read n
      code 2

task size-after-map
  like number
  send back
    call size
      call map
        make list
          code 1
          code 2
          code 3
          code 4
        read double

task add-two
  take a, like number
  take b, like number
  like number
  send back
    call add
      read a
      read b

task sum-of
  like number
  send back
    call reduce
      make list
        code 1
        code 2
        code 3
      read add-two
      code 0
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
          code 2

task is-even
  take n, like number
  like boolean
  send back
    call is-equal
      call modulo
        read n
        code 2
      code 0

task nine
  like number
  send back, code 9

task to-nine
  take n, like number
  like number
  send back, code 9

task and-then-some
  like number
  send back
    call unwrap-or
      call and-then
        make some
          bind value, code 5
        read double-maybe
      code 0

task or-else-none
  like number
  send back
    call unwrap-or
      call or-else
        make none
        make some
          bind value, code 7
      code 0

task filter-keep
  like number
  send back
    call unwrap-or
      call filter
        make some
          bind value, code 4
        read is-even
      code 0

task filter-drop
  like number
  send back
    call unwrap-or
      call filter
        make some
          bind value, code 3
        read is-even
      code 99

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
        bind value, code 8

task double-okay
  take n, like number
  like result
  send back
    make okay
      bind value
        call multiply
          read n
          code 2

task and-then-okay
  like number
  send back
    call unwrap-or
      call and-then
        make okay
          bind value, code 6
        read double-okay
      code 0

task map-second-pair
  like number
  send back
    call get-second
      call map-second
        make pair
          bind first, code 1
          bind second, code 10
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
      code 10
  send back
    call unwrap-or
      call get
        read m
        text <a>
      code 0

task get-missing
  like number
  save m
    make find
  send back
    call unwrap-or
      call get
        read m
        text <nope>
      code 99

task has-key
  like boolean
  save m
    make find
  save m
    call set
      read m
      text <x>
      code 1
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
      code 1
  save m
    call set
      read m
      text <b>
      code 2
  send back
    call size
      read m

# the canonical count verb (alias of size)
task entry-count-verb
  like number
  save m
    make find
  save m
    call set
      read m
      text <a>
      code 1
  save m
    call set
      read m
      text <b>
      code 2
  send back
    call count
      read m
`

// the range type
const RANGE = `load @cluesurf/base/code/range
  find range

task measure-range
  like number
  send back
    call length
      make range
        bind start, code 0
        bind end, code 10
        bind step, code 2

task range-list-size
  like number
  save items
    call to-list
      make range
        bind start, code 0
        bind end, code 10
        bind step, code 2
  send back
    read items/length

task range-list-first
  like number
  save items
    call to-list
      make range
        bind start, code 3
        bind end, code 9
        bind step, code 2
  send back
    call items/at
      code 0

task range-has
  like boolean
  send back
    call contains
      make range
        bind start, code 0
        bind end, code 10
        bind step, code 1
      code 5

task range-excludes-end
  like boolean
  send back
    call contains
      make range
        bind start, code 0
        bind end, code 10
        bind step, code 1
      code 10
`

const SET = `load @cluesurf/base/code/set
  find set

task add-has
  like boolean
  save s
    make set
      bind items
        make find
  save s
    call insert
      read s
      code 5
  send back
    call has
      read s
      code 5

task missing
  like boolean
  save s
    make set
      bind items
        make find
  send back
    call has
      read s
      code 99

task unique-size
  like number
  save s
    make set
      bind items
        make find
  save s
    call insert
      read s
      code 1
  save s
    call insert
      read s
      code 2
  save s
    call insert
      read s
      code 1
  send back
    call size
      read s

# the canonical count verb (alias of size)
task unique-count
  like number
  save s
    make set
      bind items
        make find
  save s
    call insert
      read s
      code 1
  save s
    call insert
      read s
      code 2
  send back
    call count
      read s
`

const STACK = `load @cluesurf/base/code/list/stack
  find stack

task push-pop
  like number
  save s
    make stack
      bind items
        make list
  save s
    call push
      read s
      code 10
  save s
    call push
      read s
      code 20
  send back
    call unwrap-or
      call pop
        read s
      code 0
`

const QUEUE = `load @cluesurf/base/code/list/queue
  find queue

task fifo
  like number
  save q
    make queue
      bind items
        make list
  save q
    call enqueue
      read q
      code 10
  save q
    call enqueue
      read q
      code 20
  send back
    call unwrap-or
      call dequeue
        read q
      code 0
`

// linked-list: a recursive immutable ADT (empty | node)
const LINKED_LIST = `load @cluesurf/base/code/list/linked-list
  find linked-list

task ll-length
  like number
  save l
    make empty
  save l
    call prepend
      read l
      code 1
  save l
    call prepend
      read l
      code 2
  send back
    call length
      read l

task ll-head
  like number
  save l
    make empty
  save l
    call prepend
      read l
      code 5
  send back
    call unwrap-or
      call head
        read l
      code 0

task ll-empty
  like boolean
  send back
    call is-empty
      make empty
`

// bag (multiset, keeps duplicates) and ordered-set (dedup, keeps order), both array-backed
const BAG = `load @cluesurf/base/code/list/bag
  find bag

task bag-size
  like number
  save b
    make bag
      bind items
        make list
  call insert
    read b
    code 5
  call insert
    read b
    code 5
  send back
    call get-size
      read b
`

const ORDERED_SET = `load @cluesurf/base/code/list/ordered-set
  find ordered-set

task oset-size
  like number
  save s
    make ordered-set
      bind items
        make list
  save s
    call insert
      read s
      code 1
  save s
    call insert
      read s
      code 1
  save s
    call insert
      read s
      code 2
  send back
    call size
      read s
`

// list breadth: sum (loop), index-of, take-first / drop-first, flatten — all native-backed or pure-loop
const LIST_EXTRAS = `load @cluesurf/base/code/list
  find list

task sum-of
  like number
  send back
    call sum
      make list
        code 1
        code 2
        code 3
        code 4

task index-of-twenty
  like number
  send back
    call index-of
      make list
        code 10
        code 20
        code 30
      code 20

task take-two-size
  like number
  send back
    call size
      call take-first
        make list
          code 1
          code 2
          code 3
          code 4
        code 2

task drop-two-size
  like number
  send back
    call size
      call drop-first
        make list
          code 1
          code 2
          code 3
          code 4
        code 2

task flatten-size
  like number
  send back
    call size
      call flatten
        make list
          make list
            code 1
            code 2
          make list
            code 3

task product-of
  like number
  send back
    call product
      make list
        code 2
        code 3
        code 4

task unique-size
  like number
  send back
    call size
      call unique
        make list
          code 1
          code 1
          code 2
          code 3
          code 3

task count-of-four
  like number
  send back
    call count
      make list
        code 1
        code 2
        code 3
        code 4

task take-last-two-first
  like number
  send back
    call get
      call take
        make list
          code 1
          code 2
          code 3
          code 4
        code 2
        make end
      code 0

task drop-last-two-size
  like number
  send back
    call size
      call drop
        make list
          code 1
          code 2
          code 3
          code 4
        code 2
        make end

task last-index-of-one
  like number
  send back
    call last-index-of
      make list
        code 1
        code 2
        code 1
      code 1
`

// pair map-both: apply a different function to each side
const PAIR_BOTH = `load @cluesurf/base/code/pair
  find pair

task double
  take n, like number
  like number
  send back
    call multiply
      read n
      code 2

task add-ten
  take n, like number
  like number
  send back
    call add
      read n
      code 10

task both-first
  like number
  save p
    call map-both
      make pair
        bind first, code 3
        bind second, code 4
      read double
      read add-ten
  send back
    read p/first

task both-second
  like number
  save p
    call map-both
      make pair
        bind first, code 3
        bind second, code 4
      read double
      read add-ten
  send back
    read p/second
`

// color: pure-logic RGB operations (grayscale, luminance, invert, is-dark, blend), all integer math
const COLOR = `load @cluesurf/base/code/color/rgb
  find rgb-color

task gray
  like number
  send back
    call grayscale
      make rgb-color
        bind red, code 30
        bind green, code 60
        bind blue, code 90

task lum-white
  like number
  send back
    call luminance
      make rgb-color
        bind red, code 255
        bind green, code 255
        bind blue, code 255

task inverted-red
  like number
  save c
    call invert
      make rgb-color
        bind red, code 0
        bind green, code 0
        bind blue, code 0
  send back
    read c/red

task dark-check
  like boolean
  send back
    call is-dark
      make rgb-color
        bind red, code 10
        bind green, code 10
        bind blue, code 10

task blended-red
  like number
  save c
    call blend
      make rgb-color
        bind red, code 100
        bind green, code 0
        bind blue, code 0
      make rgb-color
        bind red, code 200
        bind green, code 0
        bind blue, code 0
  send back
    read c/red
`

async function main(): Promise<void> {
  const cl = await loadProgram(COLOR)
  expect('color/grayscale averages the channels', cl.gray!(), 60)
  expect('color/luminance of white is 255', cl.lumWhite!(), 255)
  expect('color/invert of black gives 255 red', cl.invertedRed!(), 255)
  expect(
    'color/is-dark on a near-black color is true',
    cl.darkCheck!(),
    true,
  )
  expect('color/blend averages each channel', cl.blendedRed!(), 150)

  const pb = await loadProgram(PAIR_BOTH)
  expect(
    'pair/map-both applies the first function to first',
    pb.bothFirst!(),
    6,
  )
  expect(
    'pair/map-both applies the second function to second',
    pb.bothSecond!(),
    14,
  )

  const le = await loadProgram(LIST_EXTRAS)
  expect('list/sum totals the elements', le.sumOf!(), 10)
  expect('list/index-of finds the position', le.indexOfTwenty!(), 1)
  expect('list/take-first keeps the leading n', le.takeTwoSize!(), 2)
  expect('list/count returns the length', (le.countOfFour as () => number)(), 4)
  expect('list/take with side end keeps the trailing n (first of [3,4] is 3)', (le.takeLastTwoFirst as () => number)(), 3)
  expect('list/drop with side end drops the trailing n', (le.dropLastTwoSize as () => number)(), 2)
  expect('list/last-index-of finds the last occurrence', (le.lastIndexOfOne as () => number)(), 2)
  expect('list/drop-first removes the leading n', le.dropTwoSize!(), 2)
  expect('list/flatten merges one level', le.flattenSize!(), 3)
  expect('list/product multiplies the elements', le.productOf!(), 24)
  expect('list/unique removes duplicates', le.uniqueSize!(), 3)

  const bg = await loadProgram(BAG)
  expect(
    'bag/insert keeps duplicates (multiset size)',
    bg.bagSize!(),
    2,
  )

  const os = await loadProgram(ORDERED_SET)
  expect(
    'ordered-set/insert dedups (size counts uniques)',
    os.osetSize!(),
    2,
  )

  const ll = await loadProgram(LINKED_LIST)
  expect(
    'linked-list/length counts the nodes (recursive)',
    ll.llLength!(),
    2,
  )
  expect(
    'linked-list/head returns some of the first value',
    ll.llHead!(),
    5,
  )
  expect('linked-list/is-empty on empty is true', ll.llEmpty!(), true)

  const se = await loadProgram(SET)
  expect('set/add then has finds the value', se.addHas!(), true)
  expect('set/has on a missing value is false', se.missing!(), false)
  expect('set/size counts unique values', se.uniqueSize!(), 2)
  expect('set/count is the canonical alias of size', (se.uniqueCount as () => number)(), 2)

  const st = await loadProgram(STACK)
  expect('stack/push then pop is LIFO', st.pushPop!(), 20)

  const qu = await loadProgram(QUEUE)
  expect('queue/enqueue then dequeue is FIFO', qu.fifo!(), 10)

  const h = await loadProgram(HASH)
  expect(
    'hash/set then get returns some of the value',
    h.setAndGet!(),
    10,
  )
  expect('hash/get on a missing key returns none', h.getMissing!(), 99)
  expect('hash/has finds a set key', h.hasKey!(), true)
  expect('hash/size counts entries', h.entryCount!(), 2)
  expect('hash/count is the canonical alias of size', (h.entryCountVerb as () => number)(), 2)

  const rg = await loadProgram(RANGE)
  expect('range/length is (end-start)/step', rg.measureRange!(), 5)
  expect(
    'range/to-list produces the right count',
    rg.rangeListSize!(),
    5,
  )
  expect('range/to-list starts at start', rg.rangeListFirst!(), 3)
  expect('range/contains a value in bounds', rg.rangeHas!(), true)
  expect(
    'range/contains excludes the end',
    rg.rangeExcludesEnd!(),
    false,
  )

  const x = await loadProgram(COMBINATORS)
  expect(
    'maybe/and-then chains a maybe-returning call',
    x.andThenSome!(),
    10,
  )
  expect(
    'maybe/or-else falls back to the alternative maybe',
    x.orElseNone!(),
    7,
  )
  expect('maybe/filter keeps a passing value', x.filterKeep!(), 4)
  expect('maybe/filter drops a failing value', x.filterDrop!(), 99)
  expect(
    'maybe/get-or-else calls the thunk on none',
    x.getOrElseNone!(),
    9,
  )
  expect('maybe/unwrap returns the some value', x.unwrapSome!(), 8)
  expect(
    'result/and-then chains a result-returning call',
    x.andThenOkay!(),
    12,
  )
  expect(
    'pair/map-second maps the second element',
    x.mapSecondPair!(),
    9,
  )

  const l = await loadProgram(LIST)
  expect('list/first returns some of the head', l.firstOf!(), 10)
  expect('list/last returns some of the tail', l.lastOf!(), 30)
  expect('list/first on empty returns none', l.firstEmpty!(), 99)
  expect('list/size counts elements', l.sizeOf!(), 3)
  expect('list/contains finds a member', l.hasIt!(), true)
  expect('list/get reads by index', l.getSecond!(), 8)
  expect('list/join joins with a separator', l.joinThem!(), '1-2-3')
  expect(
    'list/reverse then size is unchanged',
    l.sizeAfterReverse!(),
    2,
  )
  expect('list/map then size is unchanged', l.sizeAfterMap!(), 4)
  expect('list/reduce sums the elements', l.sumOf!(), 6)

  const c = await loadProgram(COMBINED)
  expect(
    'combined: maybe.unwrap-or dispatches to the maybe method',
    c.fromMaybe!(),
    11,
  )
  expect(
    'combined: result.unwrap-or dispatches to the result method',
    c.fromResult!(),
    22,
  )

  const d = await loadProgram(DOCK)
  expect(
    'dock: a native module call runs (path.basename)',
    d.baseName!(),
    'file.txt',
  )

  const b = await loadProgram(BOOLEAN)
  expect('boolean/not on true is false', b.negateTrue!(), false)
  expect('boolean/not on false is true', b.negateFalse!(), true)

  const m = await loadProgram(MAYBE)
  expect(
    'maybe/unwrap-or on some returns the value',
    m.unwrapPresent!(),
    42,
  )
  expect(
    'maybe/unwrap-or on none returns the fallback',
    m.unwrapAbsent!(),
    7,
  )
  expect('maybe/is-some on some is true', m.present!(), true)
  expect('maybe/is-some on none is false', m.absent!(), false)
  expect(
    'maybe/map applies the function under some',
    m.mapAddOne!(),
    42,
  )

  const r = await loadProgram(RESULT)
  expect('result/unwrap-or on okay returns the value', r.okValue!(), 5)
  expect(
    'result/unwrap-or on error returns the fallback',
    r.errDefault!(),
    0,
  )
  expect('result/is-okay on okay is true', r.okayCheck!(), true)

  const p = await loadProgram(PAIR)
  expect('pair/get-first reads the first', p.firstOf!(), 3)
  expect(
    'pair/swap then get-second reads the original first',
    p.secondAfterSwap!(),
    3,
  )

  console.log(`\nstdlib: ${pass} pass, ${fail} fail`)
}

main()
