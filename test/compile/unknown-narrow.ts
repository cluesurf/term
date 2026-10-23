// THE GRADUAL SEAM, CLOSED (guides/types/gradual, 2026-10-05). An `unknown` takes any value in, and gives one out only
// through a run-time test: `sift value` with an arm per type (`case number`, `case float`, `case text`, `case boolean`)
// and a `miss`. Inside an arm the subject IS that type. An `unknown` handed straight to a typed place is refused by
// `term make`, where it used to build: on TypeScript text came back from a task typed to return a number, and on Rust
// `rustc` refused it, not Term. `dynamic` stays the FFI's `any`. So a value of a static type is that type at run time on
// every backend, which is the line between the open surface and the kernel's typed values.
// Run: npx tsx test/compile/unknown-narrow.ts   (NARROW_ONLY=typescript, rust, swift or kotlin runs one)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { compile } from '@term/make/code/compile/compile'
import { setUnknownSeam } from '@term/make/code/check/strict'
import { BACKENDS, runOn } from './shared/run-on'

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

// one task narrows each kind, a `link` names the narrowed value apart from the subject, and a value read through two
// unknowns arrives as itself
const PROGRAM = `task describe
  take value, like unknown

  like text

  sift value
    case number
      back <whole {add(value, 1)}>
    case float
      back <fraction>
    case text
      back <text of {value}>
    case boolean
      fork test, value
        hold
          back <yes>
        miss
          back <no>
    miss
      back <other>

task doubled
  take value, like unknown

  like number

  sift value
    case number
      link n
      back multiply(n, 2)
    miss
      back 0

task relay
  take value, like unknown

  like unknown

  back value

task run
  like text

  back <{describe(41)} {describe(2.5)} {describe(<ada>)} {describe(true)} {describe(make list)} {doubled(relay(21))} {doubled(<x>)}>
`

const EXPECTED = 'whole 42 fraction text of ada yes other 42 0'

// FLOW TYPING AFTER A TEST (decisions-2026-10.md, D10): `is-text(value)` as a branch's test narrows an `unknown` in
// the branch it guards, exactly as the `sift` arm does, in a chain of tests where each later test sits in the miss of
// the one before, and in a test with no miss that the task carries on after
const FLOW = `task kind-of
  take value, like unknown

  like text

  fork test
    hook test
      call is-text
        read value
    hook hold
      back <text {value}>
    hook test
      call is-number
        read value
    hook hold
      back <number {add(value, 1)}>
    hook miss
      back <other>

task flag
  take value, like unknown

  like text

  fork test, is-boolean(value)
    hold
      fork test, value
        hold
          back <on>
      back <off>
  back <none>

task sized
  take value, like unknown
  take big, like boolean

  like text

  fork test
    hook test
      read big
    hook hold
      back <big>
    hook test
      call is-number
        read value
    hook hold
      back <n {add(value, 1)}>
    hook miss
      back <no>

task run
  like text

  back <{kind-of(<ada>)} {kind-of(41)} {kind-of(2.5)} {flag(true)} {flag(false)} {flag(3)} {sized(1, true)} {sized(4, false)} {sized(<a>, false)}>
`

const FLOW_EXPECTED = 'text ada number 42 other on off none big n 5 no'

// A FORM, A LIST AND A HASH OUT OF AN UNKNOWN (term-decisions-2026-10-seam-0012, gap 318): `case point` tests for the
// record (natively its type, on TypeScript its shape: exactly its fields, each of its kind), `case list` / `like text`
// for a list of text (every item), `case hash` / `like text` / `like number` for a hash (every key and value). A list
// of numbers is not a list of text, a point with a text field is not a point, and a record of another form is not one
const SHAPES = `load @term/base/list
  find join

form point
  link x, like number
  link y, like number

form label
  link x, like number
  link y, like number
  link name, like text

task describe
  take value, like unknown

  like text

  sift value
    case point
      back <point {add(value/x, value/y)}>
    case list
      like text
      link names
      back <names {join(names, <+>)}>
    case hash
      like text
      like number
      link table
      back <hash {table/length()}>
    case number
      back <number {value}>
    miss
      back <other>

task run
  like text

  save p
    make point
      bind x, 1
      bind y, 2
  save l
    make label
      bind x, 1
      bind y, 2
      bind name, <a>
  save names, make list
  push(names, <ada>)
  push(names, <bo>)
  save counts, make list
  push(counts, 1)
  save table
    make hash
      save a, 1
      save b, 2
  save other
    make hash
      save a, <x>
  back <{describe(p)}, {describe(names)}, {describe(table)}, {describe(7)}, {describe(counts)}, {describe(other)}, {describe(l)}, {describe(<x>)}>
`

const SHAPES_EXPECTED = 'point 3, names ada+bo, hash 2, number 7, other, other, other, other'

// A FORM WITH CASES OUT OF AN UNKNOWN (seam decision 003): `case shape` tests for a value of any of its cases (natively
// the enum, on TypeScript its tag and that case's fields), a `mark tag` form by its own tag field, a `mark text` form
// by its case texts, and a list or a hash of a form with cases item by item. A record of a form of fields and a
// number go to the miss
const CASED = `load @term/base/list
  find push

form shape
  case dot
  case box
    link side, like number

form flag
  mark tag, name kind
  case up
  case down
    link by, like number

form tone
  mark text
  case warm
  case cool, text <ice>

form point
  link x, like number

task describe
  take value, like unknown

  like text

  sift value
    case shape
      link s
      sift s
        case dot
          back <dot>
        case box
          back <box {side}>
    case flag
      link f
      sift f
        case up
          back <up>
        case down
          back <down {by}>
    case tone
      link t
      sift t
        case warm
          back <warm>
        case cool
          back <cool>
    case list
      like shape
      link shapes
      back <shapes {shapes/length}>
    case hash
      like text
      like shape
      link table
      back <table {table/length()}>
    miss
      back <other>

task run
  like text

  save d, make dot
  save b
    make box
      bind side, 3
  save u, make up
  save n
    make down
      bind by, 2
  save w, make warm
  save c, make cool
  save shapes, like list, like shape
    make list
  push(shapes, d)
  push(shapes, b)
  save table, like hash, like text, like shape
    make hash
  table/set(<one>, b)
  save p
    make point
      bind x, 1
  back <{describe(d)}, {describe(b)}, {describe(u)}, {describe(n)}, {describe(w)}, {describe(c)}, {describe(shapes)}, {describe(table)}, {describe(p)}, {describe(7)}>
`

const CASED_EXPECTED = 'dot, box 3, up, down 2, warm, cool, shapes 2, table 1, other, other'

// A TEST OF A FORM'S CASE NARROWS (gap 105): `is-some(m)` is the `sift m` arm `case some`, so inside the branch
// `m/value` reads, and the other case is the rest. A field named like a local in scope is not bound over it
const CASES = `load @term/base/maybe
  find maybe
  find is-some
  find is-none

task show
  take m, like maybe, like text

  like text

  fork test, is-some(m)
    hold
      back <some {m/value}>
  back <none>

task other
  take m, like maybe, like text
  take extra, like text

  like text

  fork test, is-none(m)
    hold
      back <none {extra}>
    miss
      back <some {m/value} {extra}>

task run
  like text

  back <{show(make(some, <a>))} {show(make none)} {other(make(some, <b>), <c>)} {other(make(none), <d>)}>
`

const CASES_EXPECTED = 'some a none some b c none d'

// A NUMBER OUT OF A MAYBE PARAMETER (seam-0020): Rust lends a parameter, so a `sift` arm over it bound the payload as
// `&i64`, and `add(m/value, 1)` failed rustc (E0308 at `i64::checked_add(value, 1)`). A Copy payload is bound by value
const BORROWED = `load @term/base/maybe
  find maybe

task bump
  take m, like maybe, like number

  like number

  sift m
    case some
      back add(m/value, 1)
    case none
      back 0

task run
  like text

  back <{bump(make(some, 41))} {bump(make none)}>
`

const BORROWED_EXPECTED = '42 0'

const dir = mkdtempSync(join(tmpdir(), 'term-narrow-'))
const only = process.env.NARROW_ONLY ?? ''

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'narrow' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(
    `${backend}: an unknown is narrowed by a type arm, its subject typed inside it, a link names it apart, and a miss takes the rest`,
    ran.form === 'ran' && ran.output === EXPECTED,
    ran.form === 'ran' ? `got ${JSON.stringify(ran.output)}` : `${ran.stage}: ${ran.reason}`,
  )

  const flow = runOn({ backend, program: FLOW, resolve: env => projectResolver(process.cwd(), env), dir, name: 'flow' })

  ok(
    `${backend}: a test of what an unknown holds narrows it in the branch it guards, through a chain and with no miss`,
    flow.form === 'ran' && flow.output === FLOW_EXPECTED,
    flow.form === 'ran' ? `got ${JSON.stringify(flow.output)}` : flow.form === 'skipped' ? flow.reason : `${flow.stage}: ${flow.reason}`,
  )

  const shapes = runOn({ backend, program: SHAPES, resolve: env => projectResolver(process.cwd(), env), dir, name: 'shapes' })

  ok(
    `${backend}: a form, a list of text and a hash are narrowed out of an unknown, and a value of another shape goes to the miss`,
    shapes.form === 'ran' && shapes.output === SHAPES_EXPECTED,
    shapes.form === 'ran' ? `got ${JSON.stringify(shapes.output)}` : shapes.form === 'skipped' ? shapes.reason : `${shapes.stage}: ${shapes.reason}`,
  )

  const cased = runOn({ backend, program: CASED, resolve: env => projectResolver(process.cwd(), env), dir, name: 'cased' })

  ok(
    `${backend}: a form with cases, a mark tag form, a mark text form and a list and hash of one are narrowed out of an unknown, a record and a number go to the miss`,
    cased.form === 'ran' && cased.output === CASED_EXPECTED,
    cased.form === 'ran' ? `got ${JSON.stringify(cased.output)}` : cased.form === 'skipped' ? cased.reason : `${cased.stage}: ${cased.reason}`,
  )

  const cases = runOn({ backend, program: CASES, resolve: env => projectResolver(process.cwd(), env), dir, name: 'cases' })

  ok(
    `${backend}: a test of a form's case narrows the value to that case in the branch it guards`,
    cases.form === 'ran' && cases.output === CASES_EXPECTED,
    cases.form === 'ran' ? `got ${JSON.stringify(cases.output)}` : cases.form === 'skipped' ? cases.reason : `${cases.stage}: ${cases.reason}`,
  )

  const borrowed = runOn({ backend, program: BORROWED, resolve: env => projectResolver(process.cwd(), env), dir, name: 'borrowed' })

  ok(
    `${backend}: a number read out of a sift arm over a maybe parameter is a number`,
    borrowed.form === 'ran' && borrowed.output === BORROWED_EXPECTED,
    borrowed.form === 'ran' ? `got ${JSON.stringify(borrowed.output)}` : borrowed.form === 'skipped' ? borrowed.reason : `${borrowed.stage}: ${borrowed.reason}`,
  )
}

// the refusals, which need only the checker, with the seam on
if (!only || only === 'typescript') {
  setUnknownSeam(true)

  const refused = (text: string): string[] => {
    const built = compile({ file: join(dir, 'refused.tree'), text }, { resolve: projectResolver(process.cwd(), 'node'), env: 'node' })

    return built.ok ? [] : built.diagnostics.map(d => d.message)
  }

  // the guide's seam: text through an unknown to a task that wants a number
  const seam = refused(`task bump\n  take n, like number\n\n  like number\n\n  back add(n, 1)\n\ntask pass-through\n  take value, like unknown\n\n  like number\n\n  back bump(value)\n`)
  ok('an unknown handed to a number is refused, naming the narrowing', seam.some(m => m.includes('an unknown value where a number is wanted') && m.includes('sift')), seam.join(' | '))

  const returned = refused(`task give\n  take value, like unknown\n\n  like text\n\n  back value\n`)
  ok('an unknown returned where text is the result is refused', returned.some(m => m.includes('an unknown value where a text is wanted')), returned.join(' | '))

  const added = refused(`task plus-one\n  take value, like unknown\n\n  like number\n\n  back add(value, 1)\n`)
  ok('arithmetic on an unknown is refused', added.length > 0, 'compiled')

  const missing = refused(`task f\n  take value, like unknown\n\n  like number\n\n  sift value\n    case number\n      back value\n  back 0\n`)
  ok('a sift over an unknown with no miss is refused', missing.some(m => m.includes('needs a `miss`')), missing.join(' | '))

  const form = refused(`form point\n  link x, like number\n\ntask f\n  take value, like unknown\n\n  like number\n\n  sift value\n    case point\n      back value/x\n    miss\n      back 0\n`)
  ok('a form arm over an unknown builds, its subject the form inside it', form.length === 0, form.join(' | '))

  const cased = refused(`form shape\n  case dot\n  case box\n    link side, like number\n\ntask f\n  take value, like unknown\n\n  like number\n\n  sift value\n    case shape\n      back 1\n    miss\n      back 0\n`)
  ok('an arm naming a form with cases builds (seam decision 003)', cased.length === 0, cased.join(' | '))

  const generic = refused(`form held\n  head t\n  case empty\n  case full\n    link item, like t\n\ntask f\n  take value, like unknown\n\n  like number\n\n  sift value\n    case held\n      back 1\n    miss\n      back 0\n`)
  ok('an arm naming a form with cases and a type parameter is refused, saying what can be told apart', generic.some(m => m.includes('a form with type parameters') && m.includes('a form with cases')), generic.join(' | '))

  const bare = refused(`task f\n  take value, like unknown\n\n  like number\n\n  sift value\n    case list\n      back 1\n    miss\n      back 0\n`)
  ok('a list arm that does not say what the list holds is refused', bare.some(m => m.includes('says what it holds')), bare.join(' | '))

  const stray = refused(`task f\n  take value, like text\n\n  like number\n\n  sift value\n    case text\n      like number\n      back 1\n    miss\n      back 0\n`)
  ok('a `like` under an arm of a sift over a typed value is refused', stray.some(m => m.includes('names the type an unknown is tested for')), stray.join(' | '))

  const wrong = refused(`form point\n  link x, like number\n\ntask f\n  take value, like unknown\n\n  like text\n\n  sift value\n    case list\n      like text\n      link names\n      back names\n    miss\n      back <>\n`)
  ok('a list of text narrowed is a list of text, not text', wrong.some(m => m.includes('expected')), wrong.join(' | '))

  const fine = refused(`task same\n  take a, like unknown\n  take b, like unknown\n\n  like boolean\n\n  back is-equal(a, b)\n\ntask use\n  like boolean\n\n  back same(1, <a>)\n`)
  ok('any value into an unknown, and an unknown into an unknown, still build', fine.length === 0, fine.join(' | '))

  const typed = refused(`task f\n  take value, like text\n\n  like text\n\n  fork test, is-text(value)\n    hold\n      back value\n  back <>\n`)
  ok('a type test over a value already typed is refused, saying there is nothing to narrow', typed.some(m => m.includes('"value" is text already')), typed.join(' | '))

  const native = refused(`dock load\n  load <global:host>, name host\n\ntask f\n  take value, like dynamic\n\n  like number\n\n  back value\n`)
  ok('a dynamic, the FFI any, still passes both ways', native.length === 0, native.join(' | '))
}

console.log(`\nunknown-narrow: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
