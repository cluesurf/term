// A prop read off a caught value, `problem/link/actual`, on every backend. The carrier's `link` is the record of
// whichever exception was raised, which TypeScript reads as an object and the native backends hold boxed (`Rc<dyn Any>`
// on Rust, `Any?` on Swift and Kotlin). Each native emitter reads the prop out of every exception form whose link has
// it, matching the raised record the carrier keeps in `base` (`caught-prop` in compile/rust-emit.tree, swift-emit.tree,
// kotlin-emit.tree). Until 2026-10-22 it compiled on TypeScript alone: rustc said "no field `actual` on type
// `Rc<dyn Any>`", Swift "value of type 'Any?' has no member 'actual'", Kotlin "unresolved reference" (gaps 65, 168).
// Run: npx tsx test/compile/caught-prop-native.ts   (CAUGHT_ONLY=typescript, rust, swift or kotlin runs one)

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { projectDeckOf } from '@term/call/code/deck-of'
import { projectRoleOf, projectLeanOf } from '@term/call/code/role-of'
import { compile } from '@term/make/code/compile/compile'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin } from '@term/make/code/compile/kotlin'
import { BACKENDS, runOn } from './shared/run-on'
import type { Backend, Ran } from './shared/run-on'

let pass = 0
let fail = 0
const only = process.env.CAUGHT_ONLY ?? ''

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
  // the item holding one backend's own defect: that run is reported, never counted
  gap?: Partial<Record<Backend, string>>
}

// a read by a name known only at run time (http/tell.tree `expose`) threw out of the Rust, Swift and Kotlin emitters, `no
// exception the program raises has a prop ""`, since the static table took the empty name (item
// term-self-host-001-0781). `seen` keeps the loose answer alive, since a read inlined into a text says nothing of its box
const SEEN = `task seen
  take value, like unknown
  like text
  sift value
    case text
      back <t:{value}>
    case number
      back <n:{value}>
    miss
      back <other>
`

const KEYED = `load @term/base/exception
  find excess
  find timeout

${SEEN}
task check
  take n, like number
  like number
  fork test, is-above(n, 3)
    hold
      halt excess
        bind thing, text <big>
        bind limit, code 3
        bind actual, read n
  halt timeout
    bind thing, text <late>
    bind waited, code 5

task keyed
  take n, like number
  take key, like text
  like text
  save answer, <none>
  fork
    mark unsafe
    save got, check(n)
  halt take
    take problem
    save answer, seen(problem/link/{key})
  back answer
`

// a form the program declares, whose prop has two words: TypeScript stores it camel-cased (`whereFrom`) and reads the
// key by its written name, `where-from`, through `__termLinkKey` (compiler decision 015, item 0788)
const LOST = `load @term/base/exception
  find exception

form lost-thing
  like exception
    bind note, <lost>
    link where-from, like text

${SEEN}
task lose
  like number
  halt lost-thing
    bind where-from, <a.b>

task keyed
  take key, like text
  like text
  save answer, <none>
  fork
    mark unsafe
    save got, lose()
  halt take
    take problem
    save answer, seen(problem/link/{key})
  back answer
`

// the read in the module it was found in: every native emitter writes http/tell.tree. No toolchain builds it here, since
// its closure's host bindings do not build alone
const TELL = 'deck/site/code/http/tell.tree'

for (const backend of ['rust', 'swift', 'kotlin'] as const) {
  if (only && only !== backend) {
    continue
  }

  const root = join(process.cwd(), 'deck/site')
  const built = compile(
    { file: join(process.cwd(), TELL), text: readFileSync(TELL, 'utf8') },
    {
      resolve: projectResolver(root, backend),
      roleOf: projectRoleOf(root),
      leanOf: projectLeanOf(root),
      deckOf: projectDeckOf(),
      env: backend,
      library: true,
    } as never,
  ) as { ok: boolean; program: never; diagnostics: { message: string }[] }
  const emit = { rust: emitRust, swift: emitSwift, kotlin: emitKotlin }[backend] as (program: never, options: object) => string
  let threw = ''
  let length = 0

  if (built.ok) {
    try {
      length = emit(built.program, { units: true }).length
    } catch (error) {
      threw = (error as Error).message
    }
  }

  ok(
    `${backend}: ${TELL} emits (emitter throw is a failure, decision 013)`,
    built.ok && !threw && length > 0,
    threw || built.diagnostics?.[0]?.message,
  )
}

const CASES: Case[] = [
  {
    name: 'prop',
    says: 'a number prop and a text prop read off a caught excess',
    want: 'excess 9 n',
    program: `load @term/base/exception
  find excess

task check
  take n, like number
  like number
  fork test, is-above(n, 3)
    hold
      halt excess
        bind thing, text <n>
        bind limit, code 3
        bind actual, read n
  back n

task run
  like text
  save answer, <none>
  fork
    mark unsafe
    save got, check(9)
  halt take
    take problem
    save answer, <{problem/form} {problem/link/actual} {problem/link/thing}>
  back answer
`,
  },
  {
    name: 'two-forms',
    says: 'a prop two exception forms share is read off whichever was raised',
    want: 'timeout late',
    program: `load @term/base/exception
  find excess
  find timeout

task check
  take n, like number
  like number
  fork test, is-above(n, 3)
    hold
      halt timeout
        bind thing, text <late>
        bind waited, code 5
  halt excess
    bind thing, text <big>
    bind limit, code 3
    bind actual, read n

task run
  like text
  save answer, <none>
  fork
    mark unsafe
    save got, check(9)
  halt take
    take problem
    save answer, <{problem/form} {problem/link/thing}>
  back answer
`,
  },
  {
    name: 'by-key',
    says: 'a prop named at run time, its type the form raised, and a name no form has',
    want: 't:big n:9 other',
    program: `${KEYED}
task run
  like text
  back <{keyed(9, <thing>)} {keyed(9, <actual>)} {keyed(9, <nothing-here>)}>
`,
  },
  {
    name: 'by-key-two-forms',
    says: 'one key read off whichever of two forms was raised',
    want: 't:big t:late',
    program: `${KEYED}
task run
  like text
  back <{keyed(9, <thing>)} {keyed(1, <thing>)}>
`,
  },
  {
    name: 'by-key-kebab',
    says: 'a prop whose name is two words, of a form the program declares',
    want: 't:a.b',
    program: `${LOST}
task run
  like text
  back keyed(<where-from>)
`,
  },
  {
    // compiler decision 015 rules 1 and 2: only the written name hits. The stored spelling, an inherited name and a
    // name no form has read absent on all four (item 0788)
    name: 'by-key-written-only',
    says: 'a key that is the stored spelling, an inherited name, or no prop at all, reads absent',
    want: 'other other other other t:a.b',
    program: `${LOST}
task run
  like text
  back <{keyed(<whereFrom>)} {keyed(<constructor>)} {keyed(<toString>)} {keyed(<nowhere>)} {keyed(<where-from>)}>
`,
  },
  {
    // compiler decision 015 rule 3: an absent prop goes into set-field as null on all four (item 0788)
    // one body, so the keys stay in the order they were set on all four (item 0939: Rust sorted them, Kotlin wrote an
    // absent prop as the text kotlin.Unit)
    name: 'by-key-kebab-into-json',
    says: 'a two-word prop, a missing one and an inherited one, by name into a JSON body',
    want: '{"where-from":"a.b","nowhere":null,"constructor":null}',
    program: `load @term/base/json
  find make-object
  find set-field
  find stringify

${LOST}
task body-of
  take keys, like list, like text
  like text
  save answer, <none>
  fork
    mark unsafe
    save got, lose()
  halt take
    take problem
    save body, make-object()
    walk keys
      take prop
      save body, set-field(body, prop, problem/link/{prop})
    save answer, stringify(body)
  back answer

task run
  like text
  back body-of(make list(<where-from>, <nowhere>, <constructor>))
`,
  },
  {
    name: 'by-key-into-json',
    says: 'the read http/tell.tree writes: a prop by its name into a JSON body',
    want: '{"actual":9,"thing":"big"}',
    program: `load @term/base/exception
  find excess
  find exception

load @term/base/json
  find make-object
  find set-field
  find stringify

task raises
  like number
  halt excess
    bind thing, text <big>
    bind limit, code 3
    bind actual, code 9

task body-of
  take e, like exception
  like text
  save body, make-object()
  walk make list(<actual>, <thing>)
    take prop
    save body, set-field(body, prop, e/link/{prop})
  back stringify(body)

task run
  like text
  save answer, <none>
  fork
    mark unsafe
    save got, raises()
  halt take
    take problem
    save answer, body-of(problem)
  back answer
`,
  },
]

const dir = mkdtempSync(join(tmpdir(), 'term-caught-prop-'))
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

for (const one of CASES) {
  for (const backend of BACKENDS.filter(b => !only || b === only)) {
    let ran: Ran

    try {
      ran = runOn({
        backend,
        program: one.program,
        resolve: env => projectResolver(process.cwd(), env),
        dir,
        name: one.name,
      })
    } catch (error) {
      ran = { form: 'failed', stage: 'build', reason: `emitter threw: ${(error as Error).message}` }
    }

    if (ran.form === 'skipped') {
      console.log(`skip  ${backend}: ${ran.reason}`)
      continue
    }

    if (one.gap?.[backend]) {
      console.log(`gap   ${backend}: ${one.name}: ${one.gap[backend]}`)
      continue
    }

    ok(
      `${backend}: ${one.says} (${one.name})`,
      ran.form === 'ran' && ran.output === one.want,
      ran.form === 'ran'
        ? `got ${JSON.stringify(ran.output)}`
        : `${ran.stage}: ${ran.reason.slice(0, 600)}`,
    )
  }
}

console.log(`\ncaught-prop-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
