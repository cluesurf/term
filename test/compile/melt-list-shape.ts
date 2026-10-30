// The fill and melt walkers and the program hold a list in one shape (traps T-0421, item term-self-host-001-0440).
// Rust decides each list's shape over the program (the shared `Rc<RefCell<Vec>>`, or the plain `Vec` a field or a list
// of lists that owns its lists gets) before the walkers exist, and every walker reads and builds each list shared. A
// `fill` or `melt` call keeps every list shared (owned-fields and owned-elements-of see the call), and the exception
// codec, which writes the same walkers with no such call, now does too (compile/rust-program.tree). Until 2026-10-30
// the codec only kept `data`'s array list shared, and a program whose `data` hash list was plain failed rustc (E0308 at
// every `Data::Hash { list: Rc::new(...) }`).
//
// The fill and melt cases melt a value, fill it back and print what they read; the codec case raises a form with list
// props, melts it through the codec, fills it, raises it again and reads it in a handler. On TypeScript and Rust.
// Run: npx tsx test/compile/melt-list-shape.ts   (MELT_SHAPE_ONLY=rust runs one backend)

import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { runOn, type Backend } from './shared/run-on'

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

type Case = {
  name: string
  says: string
  want: string
  program: string
}

const LOADS = `load @term/host/code/base
  find data

load @term/base/maybe
  find maybe

load @term/base/list
  find list
`

const FORMS = `form point
  link x, like number
  link tag, like text

form shape
  link name, like text
  link tags, like list, like text
  link grid, like list, like list, like number
  link points, like list, like point
  link scale, like float
  link open, like boolean
  link note
    like maybe, like text
    need false
  link payload, like data

form inner
  link names, like list, like text
`

const SHOW = `task show
  take value, like shape
  like text
  save parts, make list
  push(parts, value/name)
  walk value/tags
    take t
    push(parts, t)
  walk value/grid
    take row
    save cells, make list
    walk row
      take cell
      push(cells, <{cell}>)
    push(parts, join(cells, <.>))
  walk value/points
    take p
    push(parts, <{p/x}:{p/tag}>)
  push(parts, <{value/scale}>)
  push(parts, <{value/open}>)
  sift value/note
    case some
      link written
      push(parts, <some:{written}>)
    case none
      push(parts, <none>)
  save back-in
    call fill
      read value/payload
      like inner
  walk back-in/names
    take n
    push(parts, n)
  back join(parts, <,>)
`

const CASES: Case[] = [
  {
    name: 'fresh',
    says: 'a form built fresh, its lists pushed to: melt, then fill, reads the same',
    want: 'box,a,b,1.2,3,4:p,5:q,1.5,true,some:hi,u,v',
    program: `${LOADS}
${FORMS}
${SHOW}
task run
  like text
  save tags, make list
  push(tags, <a>)
  push(tags, <b>)
  save grid, make list
  save row1, make list
  push(row1, 1)
  push(row1, 2)
  push(grid, row1)
  save row2, make list
  push(row2, 3)
  push(grid, row2)
  save points, make list
  save p1
    make point
      bind x, 4
      bind tag, <p>
  push(points, p1)
  save p2
    make point
      bind x, 5
      bind tag, <q>
  push(points, p2)
  save names, make list
  push(names, <u>)
  push(names, <v>)
  save carried
    make inner
      bind names, names
  save payload
    call melt
      read carried
      like inner
  save given
    make shape
      bind name, <box>
      bind tags, tags
      bind grid, grid
      bind points, points
      bind scale, 1.5
      bind open, true
      bind note, make(some, <hi>)
      bind payload, payload
  save melted
    call melt
      read given
      like shape
  save filled
    call fill
      read melted
      like shape
  back show(filled)
`,
  },
  {
    name: 'empty',
    says: 'empty lists and a none maybe round-trip',
    want: 'nil,2.5,false,none',
    program: `${LOADS}
${FORMS}
${SHOW}
task run
  like text
  save carried
    make inner
      bind names, make list
  save payload
    call melt
      read carried
      like inner
  save given
    make shape
      bind name, <nil>
      bind tags, make list
      bind grid, make list
      bind points, make list
      bind scale, 2.5
      bind open, false
      bind note, make none
      bind payload, payload
  save melted
    call melt
      read given
      like shape
  save filled
    call fill
      read melted
      like shape
  back show(filled)
`,
  },
  {
    name: 'codec',
    says: 'the exception codec, with no fill or melt call: a raise with list props crosses and is caught again',
    want: '3,a+b,9,7',
    program: `load @term/base/exception
  find exception

load @term/base/maybe
  find maybe

load @term/host/code/base
  find data

load @term/base/list
  find list
  find get

form over-limit
  like exception
    bind note, <Over the limit>
    link labels, like list, like text
    link grid, like list, like list, like number

bind melt-raise
  take raised, like exception
  like data
  case node
    text <__termMeltRaise($raised)>
  case rust
    text <term_melt_raise(&$raised)>
  case browser
    text <0>
  case swift
    text <0>
  case kotlin
    text <0>

bind reraise
  take given, like data
  like number
  case node
    text <(() =\\> \\{ throw __termFillRaise($given) \\})()>
  case rust
    text <\\{ return std::result::Result::Err(match term_fill_raise($given) \\{ Ok(e) =\\> e, Err(e) =\\> e \\}); \\}>
  case browser
    text <0>
  case swift
    text <0>
  case kotlin
    text <0>

task spin
  take xs, like list, like number
  like number
  walk xs, mark parallel
    take x
    save y, check(x)
  back 0

task check
  take n, like number
  like number
  fork test, is-above(n, 3)
    hold
      save labels, make list
      push(labels, <a>)
      push(labels, <b>)
      save grid, make list
      save row, make list
      push(row, n)
      push(row, 7)
      push(grid, row)
      halt over-limit
        bind labels, labels
        bind grid, grid
  back n

task total
  like number
  save rows, make list
  save one, make list
  push(one, 1)
  push(one, 2)
  push(rows, one)
  save sum, 0
  walk rows
    take r
    walk r
      take c
      save sum, add(sum, c)
  back sum

task crossed
  take given, like data
  take n, like number
  like number
  fork test, is-below(n, 0)
    hold
      halt over-limit
        bind labels, make list
        bind grid, make list
  save z, reraise(given)
  back z

task run
  like text
  save out, make list
  push(out, <{total()}>)
  fork
    mark unsafe
    save a, check(9)
  halt take
    take problem
    save given, melt-raise(problem)
    fork
      mark unsafe
      save b, crossed(given, 1)
    halt take
      take back-in
      sift back-in
        case over-limit
          push(out, join(labels, <+>))
          walk grid
            take r
            walk r
              take c
              push(out, <{c}>)
        miss
          push(out, <other:{back-in/form}>)
  back join(out, <,>)
`,
  },
]

const HERE =
  import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const root = mkdtempSync(join(tmpdir(), 'term-melt-shape-'))
mkdirSync(join(root, 'link/@term'), { recursive: true })
mkdirSync(join(root, 'code'), { recursive: true })
symlinkSync(join(TERM, 'deck/base'), join(root, 'link/@term/base'))
symlinkSync(join(TERM, 'deck/host'), join(root, 'link/@term/host'))
writeFileSync(
  join(root, 'deck.tree'),
  'deck @probe/melt-shape\n  code <0.0.0>\n',
)

const dir = join(root, 'out')
mkdirSync(dir, { recursive: true })
const only = process.env.MELT_SHAPE_ONLY ?? ''
const BACKS: Backend[] = ['typescript', 'rust']

for (const one of CASES) {
  for (const backend of BACKS.filter(b => !only || b === only)) {
    const ran = runOn({
      backend,
      program: one.program,
      resolve: env => projectResolver(root, env),
      dir,
      name: one.name,
    })

    if (ran.form === 'skipped') {
      console.log(`skip  ${backend}: ${ran.reason}`)
      continue
    }

    ok(
      `${backend}: ${one.says} (${one.name})`,
      ran.form === 'ran' && ran.output === one.want,
      ran.form === 'ran'
        ? `got ${JSON.stringify(ran.output)}`
        : `${ran.stage}: ${ran.reason.slice(0, 1600)}`,
    )
  }
}

console.log(`\nmelt-list-shape: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
