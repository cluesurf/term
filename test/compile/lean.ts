// The lean equivalence gate.
//
// Lean is a SURFACE: a file whose role carries `mark lean` reads a bare head as a call and a property head as
// a named argument, and nothing else changes. So the whole bug class the feature can have is the two spellings
// building different programs. Every fixture here is written twice, lean and long, milled with the flag on
// and off respectively, and compared after the checker has resolved the labels, which is where the two
// spellings are meant to converge. A difference is a failure. note/term/lean.md.
//
// Run: npx tsx test/compile/lean.ts

import { compile } from '@term/make/code/compile/compile'

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

// the definitions every fixture shares: a form, a task with a list parameter, a default and a flag
const PRELUDE = `
form point
  link a, like number
  link b, like number

form bundle
  link key, like text
  link states, like list, like text

task dimension
  take key, like text
  take states, like list, like text
  take max-count, like number, fall 1
  take strict, like boolean, fall false
  like text
  send back, read key

task later
  note async
  take n, like number
  like number
  send back, read n
`

// the emitted TypeScript, or the diagnostics as one string when it did not build
function emit(body: string, lean: boolean): string {
  const out = compile(
    { file: '/gate/code/lean.tree', text: PRELUDE + body },
    { leanOf: () => lean },
  )

  return out.ok
    ? out.typescript
    : `DIAGNOSTICS: ${out.diagnostics.map(d => d.message).join(' | ')}`
}

type Pair = { name: string; lean: string; long: string }

const PAIRS: Pair[] = [
  {
    name: 'a call with property heads, stacked',
    lean: `
task go
  like text
  save r
    dimension
      key <tense>
      states <present>, <imperfect>
      max-count 1
  send back, read r
`,
    long: `
task go
  like text
  save r
    call dimension
      bind key, text <tense>
      bind states
        make list
          text <present>
          text <imperfect>
      bind max-count, code 1
  send back, read r
`,
  },
  {
    name: 'a call with single-valued properties on one line and the list stacked',
    lean: `
task go
  like text
  save r
    dimension key <tense>, max-count 1
      states <present>, <imperfect>
  send back, read r
`,
    long: `
task go
  like text
  save r
    call dimension
      bind key, text <tense>
      bind max-count, code 1
      bind states
        make list
          text <present>
          text <imperfect>
  send back, read r
`,
  },
  {
    name: 'a bare word names a boolean parameter, so it is that flag set to true',
    lean: `
task go
  like text
  save r
    dimension key <tense>, strict
      states <present>
  send back, read r
`,
    long: `
task go
  like text
  save r
    call dimension
      bind key, text <tense>
      bind strict, true
      bind states
        make list
          text <present>
  send back, read r
`,
  },
  {
    name: 'an explicit bind inside a lean call is the long-form escape and keeps its name',
    lean: `
task go
  like text
  save r
    dimension
      bind key, text <tense>
      states <present>
  send back, read r
`,
    long: `
task go
  like text
  save r
    call dimension
      bind key, text <tense>
      bind states
        make list
          text <present>
  send back, read r
`,
  },
  {
    name: 'make with property heads fills the fields',
    lean: `
task shape
  like point
  save p, make point, a 10, b 20
  send back, read p
`,
    long: `
task shape
  like point
  save p
    make point
      bind a, code 10
      bind b, code 20
  send back, read p
`,
  },
  {
    name: 'a bare head that names a form is a construction of that form',
    lean: `
task shape
  like point
  save p
    point
      a 10
      b 20
  send back, read p
`,
    long: `
task shape
  like point
  save p
    make point
      bind a, code 10
      bind b, code 20
  send back, read p
`,
  },
  {
    name: 'a property whose value is a read heads its own line',
    lean: `
task shape
  like point
  save p, make point, a 10, b 20
  save q
    point
      a, read p/b
      b, read p/a
  send back, read q
`,
    long: `
task shape
  like point
  save p
    make point
      bind a, code 10
      bind b, code 20
  save q
    make point
      bind a, read p/b
      bind b, read p/a
  send back, read q
`,
  },
  {
    // a bare head naming a CASE of a sum builds that case, tagged with its `form`, nested under a property
    name: 'a bare head that names a variant is a construction of that case',
    lean: `
form pattern
  case feature
    link feature, like text
    link value, like text
  case reference
    link element, like text

form construct
  link key, like text
  link pattern, like pattern

task shape
  like construct
  send back
    construct key <noun>
      pattern
        feature feature <part_of_speech>, value <noun>
`,
    long: `
form pattern
  case feature
    link feature, like text
    link value, like text
  case reference
    link element, like text

form construct
  link key, like text
  link pattern, like pattern

task shape
  like construct
  send back
    make construct
      bind key, text <noun>
      bind pattern
        make feature
          bind feature, text <part_of_speech>
          bind value, text <noun>
`,
  },
  {
    // the stdlib's own idiom: an explicit `bind` on a receiver-dispatched method is documentation, and lean
    // must leave it exactly as the long form has it, because the labels did not come from property heads
    name: 'an explicit bind on a receiver method is untouched under lean',
    lean: `
form box
  link items, like list

  task push
    take self
    take item, like number
    like number
    send back
      call self/items/push
        read item

task count
  like number
  save b
    make box
      bind items
        make list
  call push
    bind self, read b
    bind item, code 1
  send back, read b/items/length
`,
    long: `
form box
  link items, like list

  task push
    take self
    take item, like number
    like number
    send back
      call self/items/push
        read item

task count
  like number
  save b
    make box
      bind items
        make list
  call push
    bind self, read b
    bind item, code 1
  send back, read b/items/length
`,
  },
  {
    // an anonymous task in value position keeps its `take`: `mine task` used to read the first `take` line as
    // the task's NAME and drop the parameter (lean-0014). The same under both spellings, so the pair is equal
    // and, more to the point, neither is a diagnostic
    name: 'an anonymous task keeps its parameter',
    lean: `
task first
  take xs, like list, like number
  like number
  save found
    call xs/find
      task
        take one, like number
        like boolean
        back is-above one, 1
  back found
`,
    long: `
task first
  take xs, like list, like number
  like number
  save found
    call xs/find
      task
        take one, like number
        like boolean
        send back
          call is-above
            read one
            code 1
  send back, read found
`,
  },
  {
    name: 'a builtin written as a bare head folds to its operator',
    lean: `
task both
  take a, like boolean
  take b, like boolean
  like boolean
  back and a, b
`,
    long: `
task both
  take a, like boolean
  take b, like boolean
  like boolean
  send back
    call and
      read a
      read b
`,
  },
  {
    // the same rule on a CALL: a list PARAMETER accumulates its heads too, so the two surfaces agree
    name: 'a list parameter accumulates across repeated property heads',
    lean: `
task go
  like text
  send back
    dimension
      key <tense>
      states <present>
      states <imperfect>
      max-count 1
`,
    long: `
task go
  like text
  send back
    call dimension
      bind key
        text <tense>
      bind states
        make list
          text <present>
          text <imperfect>
      bind max-count
        code 1
`,
  },
  {
    // A NESTED OBJECT NEEDS NO `make`. The labels under `at` are point's own fields, and the enclosing
    // schema is the only thing that knows: position picks the namespace and the name picks the answer.
    name: 'a nested object by label, with no make',
    lean: `
form shape
  link name, like text
  link at, like point

task go
  like shape
  send back
    shape
      name <corner>
      at
        a 10
        b 20
`,
    long: `
form shape
  link name, like text
  link at, like point

task go
  like shape
  send back
    make shape
      bind name, text <corner>
      bind at
        make point
          bind a, code 10
          bind b, code 20
`,
  },
  {
    // A SECOND `take` binds the turn's index. A walk could not name its own position at all before, and the
    // answer was a `save` counter beside the loop. Short form: the walk's own takes are item then index.
    // Long form: the `hook next` take is the item and the walk's own take is the index.
    name: 'a walk binds its index with a second take',
    lean: `
task label
  take xs, like list, like text
  like text
  save out, text <>
  walk read(xs)
    take one
    take at
    save out
      text <{{out}}{{at}}{{one}}>
  send back, read out
`,
    long: `
task label
  take xs, like list, like text
  like text
  save out, text <>
  walk list, read(xs)
    take at
    hook next
      take site, name one
      save out
        text <{{out}}{{at}}{{one}}>
  send back, read out
`,
  },
  {
    // The bare-head call now matches the same modifier sites `call` does, so an awaited or piped call means
    // one thing in both spellings. `hook` is the one site left off, and `note` the other: the parity run found
    // `hook make` is a statement in the mill dialect, 325 of them across 110 grammar files. lean-0030.
    name: 'a bare-head call takes the same wait and link modifiers `call` does',
    lean: `
task go
  note async
  take n, like number
  like number
  send back
    later n
      wait true
`,
    long: `
task go
  note async
  take n, like number
  like number
  send back
    call later
      read n
      wait true
`,
  },
  {
    // A fork's arms with no `hook`. Decidable: hold, miss, step, fall and else can only be arms there.
    name: 'a fork whose arms drop their hook',
    lean: `
task pick
  take n, like number
  like text
  fork test, is-above(n, 1)
    hold
      send back
        text <big>
    miss
      send back
        text <small>
`,
    long: `
task pick
  take n, like number
  like text
  fork test
    hook test
      call is-above
        read n
        code 1
    hook hold
      send back
        text <big>
    hook miss
      send back
        text <small>
`,
  },
  {
    // A SHORTER WALK: the mode is a closed set of three words, so anything else is the sequence, and the item
    // binding and the body may sit directly under the walk with no `hook next`. Both halves are outside the
    // lean mark, so this pair is the short form against the long one, not lean against long.
    name: 'a walk with no mode word and no hook next',
    lean: `
task total
  take xs, like list, like number
  like number
  save sum, code 0
  walk read(xs)
    take one
    save sum
      add
        read sum
        read one
  send back, read sum
`,
    long: `
task total
  take xs, like list, like number
  like number
  save sum, code 0
  walk list, read(xs)
    hook next
      take site, name one
      save sum
        call add
          read sum
          read one
  send back, read sum
`,
  },
  {
    // `wait <call>` as a PREFIX, and the `wait true` child marker, building the same program. OUTSIDE the lean
    // mark on purpose: it is decidable with no schema, so every file gets it and `wait do-x` is the same text
    // whether the file is lean or not. Both sides of this pair are compiled with the flag ON, which is what
    // makes it a test of the prefix rather than of lean.
    // And the argument is `n`, not `read(n)`: a bare word in value position is already the variable, so the
    // two spellings build the same call. The long side keeps `read` because that is how the file is written
    // today; both are legal in both.
    name: 'wait is a prefix over a call, and the child marker still means the same',
    lean: `
task go
  note async
  take n, like number
  like number
  send back
    wait later(n)
`,
    long: `
task go
  note async
  take n, like number
  like number
  send back
    call later
      read n
      wait true
`,
  },
  {
    // A BUILTIN HAS NO PARAMETER NAMES, so a bare-head child under one is a nested CALL and never a label.
    // It used to become a named argument whose value is an array, and `foldBuiltin` folded the array itself
    // as an operand: `divide / subtract / ...` emitted `subtractArray / step`. Found by porting a real stdlib
    // module to lean (lean-0011), which is what that item is for.
    name: 'a builtin nests another builtin, stacked, as a positional argument',
    lean: `
task span
  take a, like number
  take b, like number
  take c, like number
  like number
  back
    divide
      subtract
        read a
        read b
      read c
`,
    long: `
task span
  take a, like number
  take b, like number
  take c, like number
  like number
  send back
    call divide
      call subtract
        read a
        read b
      read c
`,
  },
  {
    // A MACRO ARGUMENT BY ITS HEAD, which is the one lean case that needs no role mark and no signature
    // lookup: a template's parameters are its own `take` names in the same file. A `tree` or a `fuse` never
    // reaches a mill (template.ts expands both before any mill runs), so this cannot be a pass over the match.
    name: 'a macro argument binds by its head, and `bind` is the long form of it',
    lean: `
tree sound-row
  take symbol
  take gloss

  hook fuse
    task describe-{symbol}
      like text
      send back
        text <{gloss}>

fuse sound-row
  symbol a
  gloss open

task go
  like text
  send back
    call describe-a
`,
    long: `
tree sound-row
  take symbol
  take gloss

  hook fuse
    task describe-{symbol}
      like text
      send back
        text <{gloss}>

fuse sound-row
  bind symbol, a
  bind gloss, open

task go
  like text
  send back
    call describe-a
`,
  },
  {
    // A ONE-ELEMENT LIST IS NOT ITS ELEMENT. The `like` says which, and until 2026-09-13 the COUNT did, so a
    // one-entry table and a scalar were the same bytes with the type written on the line above.
    name: 'a host whose declared type is a list builds one however many entries it holds',
    lean: `
host one
  like list
    like number
  code 7

task go
  like number
  send back
    read one/0
`,
    long: `
host one
  like list
    like number
  make list
    code 7

task go
  like number
  send back
    read one/0
`,
  },
  {
    // a LIST field repeats its head, one entry per line, which is how a DSL wants to write one. The rule is
    // the declared type, exactly as for a single head: a list accumulates, and a scalar given twice is refused.
    name: 'a list field accumulates across repeated property heads',
    lean: `
task go
  like bundle
  send back
    bundle
      key <tense>
      states <present>
      states <imperfect>
      states <aorist>
`,
    long: `
task go
  like bundle
  send back
    make bundle
      bind key
        text <tense>
      bind states
        make list
          text <present>
          text <imperfect>
          text <aorist>
`,
  },
]

for (const pair of PAIRS) {
  const lean = emit(pair.lean, true)
  const long = emit(pair.long, false)

  ok(
    pair.name,
    lean === long && !lean.startsWith('DIAGNOSTICS'),
    lean === long ? lean : `\n--- lean ---\n${lean}\n--- long ---\n${long}`,
  )
}

// and the things lean must REFUSE, each with the reason a reader gets
const REFUSALS: { name: string; text: string; expect: string }[] = [
  {
    name: 'a label the callee does not have',
    text: `
task go
  like text
  send back
    dimension key <tense>, kee <x>
      states <present>
`,
    expect: 'has no parameter "kee"',
  },
  {
    name: 'two values into a scalar parameter',
    text: `
task go
  like text
  send back
    dimension
      key <tense>, <mood>
      states <present>
`,
    expect: 'takes one value, and this gives 2',
  },
  {
    name: 'a multi-valued property written inline after another property is split by the comma',
    text: `
task go
  like text
  send back
    dimension key <tense>, states <present>, <imperfect>, max-count 1
`,
    expect: 'given twice',
  },
  {
    name: 'a bare word that is neither in scope nor a boolean parameter',
    text: `
task go
  like text
  send back
    dimension key <tense>, loose
      states <present>
`,
    expect: 'is not defined',
  },
  {
    name: 'a stray positional in a form construction',
    text: `
task shape
  like point
  save p, make point, a 10, b 20
  send back
    point a, read p/b
`,
    expect: 'needs a field name as its head',
  },
  // THE COMMA TRAP, both shapes it was met in during the Sanskrit port. The comma pops one level, so the
  // inline call after it stays open and the statement head is left holding an extra argument. It used to be
  // reported as `the name "back" is not defined`, pointing at a whole line with nothing wrong on it, and it
  // cost an hour each time.
  {
    name: 'a statement head left holding an extra argument by a comma (send back)',
    text: `
task shape
  like number
  back dimension key <tense>, 0, 1
`,
    expect: '`back` is a statement',
  },
  {
    name: 'a statement head left holding an extra argument by a comma (fork)',
    text: `
task shape
  take n, like number
  like number
  fork test, is-above add(n, n), 1
    hook hold
      send back, read n
  send back, read n
`,
    expect: '`fork` is a statement',
  },
  // a `hook` under a call. It used to build `letters.flatMap()` with no argument and no message: the whole
  // callback vanished on a clean build.
  {
    name: 'a hook under a call, which is not a callback spelling',
    text: `
task go
  take letters, like list, like text
  like list
    like text
  send back
    call letters/flat-map
      hook next
        take one, like text
        like list
          like text
        send back
          make list
            read one
`,
    expect: 'is not read as an argument',
  },
  // and a SCALAR parameter given twice is still refused, on a call as on a construction
  {
    name: 'a scalar parameter given twice on a call',
    text: `
task go
  like text
  send back
    dimension
      key <tense>
      states <present>
      key <mood>
`,
    expect: 'given twice',
  },
  // a field the form does not declare. The comma pops ONE level, so an inline construction is still open when
  // the next property arrives and swallows it: `position some value 3, description <x>` shipped
  // `{ form: "some", value: 3, description: ["x"] }` on a clean build, with the enclosing field left empty.
  {
    name: 'a property that landed inside an inline construction the comma left open',
    text: `
task shape
  like point
  send back
    point a 10, b 20, c 30
`,
    expect: 'has no field "c"',
  },
  // a scalar field given twice. It used to emit `{ a: 10, b: 20, a: 30 }`: the second silently replaced the
  // first, which built two wrong tables in the Sanskrit port and was caught only by a parity test.
  {
    name: 'a scalar property head given twice on a construction',
    text: `
task shape
  like point
  send back
    point
      a 10
      b 20
      a 30
`,
    expect: 'is given twice',
  },
  // a statement inside an arm of a VALUE-position fork. The whole fork used to vanish and the backend emitted
  // `undefined` as the value, so every augmented athematic form came out `undefinedasmi` on a clean build.
  {
    name: 'a statement inside an arm of a value-position fork',
    text: `
task pick
  take n, like number
  like text
  save word
    fork test
      hook test
        is-above n, code 1
      hook hold
        save big, text <big>
        read big
      hook miss
        text <small>
  send back, read word
`,
    expect: 'one value per arm',
  },
  // a loop-only statement outside a loop. This compiled and then failed in the EMITTED TypeScript with
  // `Cannot use "continue" here`, which is a diagnostic in the wrong language pointing at generated code.
  {
    name: 'turn next outside a loop',
    text: `
task shape
  take n, like number
  like number
  fork test, is-above n, code 1
    hook hold
      turn next
  send back, read n
`,
    expect: '`turn next` is only valid inside a loop',
  },
]

for (const refusal of REFUSALS) {
  const out = emit(refusal.text, true)

  ok(
    `refuses: ${refusal.name}`,
    out.startsWith('DIAGNOSTICS') && out.includes(refusal.expect),
    out,
  )
}

// and the long form under the lean flag is unchanged: a file may be written entirely long and mean the same
{
  const body = PAIRS[0]!.long

  ok('the long form means the same with the flag on', emit(body, true) === emit(body, false))
}

// ---- the host role: a data file ----

// a data file compiles to its value as JSON. Under the mark, a head the dialect does not know, carrying a
// value, is a `host` entry keyed by that head; `list` stays `list`.
function emitData(text: string, lean: boolean): string {
  const out = compile(
    { file: '/gate/data/lean.tree', text },
    { roleOf: () => 'host', leanOf: () => lean },
  )

  return out.ok
    ? out.typescript
    : `DIAGNOSTICS: ${out.diagnostics.map(d => d.message).join(' | ')}`
}

const DATA_PAIRS: Pair[] = [
  {
    name: 'host: scalars by their own head',
    lean: `key <tense>\nmax-count 1\nstrict true\n`,
    long: `host key, <tense>\nhost max-count, 1\nhost strict, true\n`,
  },
  {
    name: 'host: a map by its own head, with entries by theirs',
    lean: `point\n  a 10\n  b 20\n`,
    long: `host point\n  host a, 10\n  host b, 20\n`,
  },
  {
    name: 'host: a list still says list, and lean entries sit beside it',
    lean: `name <tense>\nlist states\n  <present>, <imperfect>\n`,
    long: `host name, <tense>\nlist states\n  <present>, <imperfect>\n`,
  },
  {
    name: 'host: the long form is unchanged under the mark',
    lean: `host key, <tense>\nlist states\n  <a>, <b>\n`,
    long: `host key, <tense>\nlist states\n  <a>, <b>\n`,
  },
]

for (const pair of DATA_PAIRS) {
  const lean = emitData(pair.lean, true)
  const long = emitData(pair.long, false)

  ok(
    pair.name,
    lean === long && !lean.startsWith('DIAGNOSTICS'),
    lean === long ? lean : `\n--- lean ---\n${lean}\n--- long ---\n${long}`,
  )
}

// two values under a bare head is not a list: the reader says to write `list`, as it does for `host`
{
  const out = emitData(`states <a>, <b>\n`, true)

  ok(
    'host refuses: two values under a bare head, and says to write list',
    out.startsWith('DIAGNOSTICS') && out.includes('A list is written "list states"'),
    out,
  )
}

// and without the mark, a bare head is not data at all
{
  const out = emitData(`key <tense>\n`, false)

  ok(
    'host refuses: a bare head without the mark is not data',
    out.startsWith('DIAGNOSTICS') && out.includes('is not data'),
    out,
  )
}

// ---- the view role: a document ----

// a document compiles through the view reader and lowering. Under the mark, a plain-name child of a placement
// with a value is a `bind` whose term is its head. The `view` head itself stays (lean-0029).
function emitView(text: string, lean: boolean): string {
  const out = compile(
    { file: '/gate/view/lean.tree', text },
    { roleOf: () => 'view', leanOf: () => lean },
  )

  return out.ok
    ? out.typescript
    : `DIAGNOSTICS: ${out.diagnostics.map(d => d.message).join(' | ')}`
}

const VIEW_PAIRS: Pair[] = [
  {
    name: 'view: a placement takes its inputs by their own heads',
    lean: `view page\n  view text/term\n    label <alpha>\n    size 2\n`,
    long: `view page\n  view text/term\n    bind label, <alpha>\n    bind size, 2\n`,
  },
  {
    name: 'view: an input under a nested placement',
    lean: `view page\n  view data/row\n    view text/term\n      label <alpha>\n`,
    long: `view page\n  view data/row\n    view text/term\n      bind label, <alpha>\n`,
  },
  {
    name: 'view: the long form is unchanged under the mark',
    lean: `view page\n  view text/term\n    bind label, <alpha>\n`,
    long: `view page\n  view text/term\n    bind label, <alpha>\n`,
  },
  {
    // `text` is a BODY head in the view dialect (a text node), so an input called `text` keeps its `bind`:
    // the lean spelling of that line is a text child, on purpose, and the same under the mark or not
    name: 'view: `text` is a body head, so a bare `text <x>` is a text node under the mark too',
    lean: `view page\n  view text/term\n    text <alpha>\n`,
    long: `view page\n  view text/term\n    text <alpha>\n`,
  },
]

for (const pair of VIEW_PAIRS) {
  const lean = emitView(pair.lean, true)
  const long = emitView(pair.long, false)

  ok(
    pair.name,
    lean === long && !lean.startsWith('DIAGNOSTICS'),
    lean === long ? lean : `\n--- lean ---\n${lean}\n--- long ---\n${long}`,
  )
}

// a component input takes one value
{
  const out = emitView(`view page\n  view text/term\n    label <a>, <b>\n`, true)

  ok(
    'view refuses: two values into one input',
    out.startsWith('DIAGNOSTICS') && out.includes('takes one'),
    out,
  )
}

console.log(`\nlean: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
