// `twin <task>, name <label>` reaches the compiler whole, and reaches no backend (optimize-0005).
//
// A twin is another implementation of a named task (note/term/optimize/words.md). The mill returns it BESIDE the
// program and never in it, so every pass and backend that does not choose between implementations emits the
// reference, which is always correct. This holds the grammar's two halves (a site with a `mine` half and no `mint`
// bind parses and then vanishes), the fields the `Twin` carries, the refusals, and that the program is unchanged by
// the twins in the file.
// Run: npx tsx test/compile/twin.ts

import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import { millByGrammar } from '@term/make/code/compile/mint-bridge'
import { compile } from '@term/make/code/compile/compile'
import type { Twin } from '@term/make/code/compile/node'

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `  ${detail}` : ''}`)
  }
}

const REFERENCE = `task count-each
  take values, like list, like number
  take queries, like list, like number
  like list, like number
  save counts
    make list
  walk list, read queries
    hook next
      take site, name query
      save count, code 0
      walk list, read values
        hook next
          take site, name value
          fork test
            hook test
              call is-equal
                read value
                read query
            hook hold
              save count
                call add
                  read count
                  code 1
      call push
        bind list, read counts
        bind item, read count
  send back, read counts
`

const TWINS = `twin count-each, name tally
  take values
  take queries
  cost
    call add
      call size
        read values
      call size
        read queries
  host tally
    call tally
      read values
  save counts
    make list
  walk list, read queries
    hook next
      take site, name query
      call push
        bind list, read counts
        bind item
          call tally/get-or-default
            read query
            code 0
  send back, read counts

twin count-each, name dense
  take values
  take queries
  have
    call is-sorted
      read values
  hook test
    call is-every-within
      bind list, read values
      bind base, code 0
      bind head, code 65536
  ease float-order
  mark width, like number
  mark platform, name rust
  mark trust
  send back
    make list
`

function millText(text: string) {
  const parsed = parse({ file: 'main.tree', text })

  if (!parsed.ok) {
    throw new Error('parse failed')
  }

  return { viaMill: mill(parsed.tree, 'main.tree'), viaGrammar: millByGrammar(parsed.tree, 'main.tree') }
}

const strip = (value: unknown): string =>
  JSON.stringify(value, (key, v) => (key === 'span' ? undefined : v))

// the reference alone, and the reference with two twins beside it
const alone = millText(REFERENCE).viaGrammar
const both = millText(`${REFERENCE}\n${TWINS}`).viaGrammar

ok('the reference mills', alone.ok)
ok('the reference with twins beside it mills', both.ok, both.ok ? '' : JSON.stringify((both as { diagnostics: unknown }).diagnostics).slice(0, 300))

if (alone.ok && both.ok) {
  ok('the twins add no statement: the program is the reference program', strip(alone.program) === strip(both.program))

  const twins: Twin[] = both.twins ?? []
  ok('both twins are returned beside the program', twins.length === 2, `got ${twins.length}`)

  const tally = twins.find(t => t.name === 'tally')
  const dense = twins.find(t => t.name === 'dense')

  ok('a twin names the task it twins', tally?.of === 'count-each' && dense?.of === 'count-each')
  ok('its parameters are names, in order', JSON.stringify(tally?.params) === '["values","queries"]')
  ok('its body is read as an ordinary body', (tally?.body.length ?? 0) === 4, `got ${tally?.body.length}`)
  // `call add` lowers to the builtin `+`, as it does anywhere else
  ok('`cost` is read as one expression', tally?.cost?.form === 'binary' && tally.cost.op === '+')
  ok('a twin with no cost has none', dense?.cost === undefined)
  ok('`have` is read', dense?.have.length === 1 && dense.have[0]?.form === 'call')
  ok('`hook test` is read', dense?.test.length === 1 && dense.test[0]?.form === 'call')
  ok('`ease` names a relaxation', JSON.stringify(dense?.ease) === '["float-order"]')
  ok('`mark` declares a knob with its type', dense?.knobs[0]?.name === 'width' && dense.knobs[0]?.type?.kind === 'number')
  ok('`mark platform, name rust` names the target', JSON.stringify(dense?.platform) === '["rust"]', JSON.stringify(dense?.platform))
  ok('`mark trust` is read', dense?.trust === true && tally?.trust === false)
  ok('a twin with nothing said is eligible everywhere and trusts nothing', JSON.stringify(tally?.platform) === '[]' && tally?.ease.length === 0)
}

// the compiler's own entry point keeps the twins too, so nothing between the mill and a later pass loses them
const viaMill = millText(`${REFERENCE}\n${TWINS}`).viaMill
ok('mill() carries the twins through', viaMill.ok && (viaMill.twins?.length ?? 0) === 2)

// refusals: a typed parameter (the type is the task's), and a twin with no label
const typed = millText(`${REFERENCE}\ntwin count-each, name typed\n  take values, like list\n  take queries\n  send back\n    make list\n`).viaGrammar
ok(
  "a twin's parameter with a type is refused, saying where the type comes from",
  !typed.ok && JSON.stringify(typed.diagnostics).includes('take their types from'),
)

const unlabelled = millText(`${REFERENCE}\ntwin count-each\n  take values\n  take queries\n  send back\n    make list\n`).viaGrammar
ok('a twin with no label is refused', !unlabelled.ok && JSON.stringify(unlabelled.diagnostics).includes('name <label>'))

// ---- what the compiler refuses about a twin without running anything (check/twin.ts, optimize-0006) ----

const PURE = `task double
  take n, like number
  like number
  send back
    call add
      read n
      read n
`

const IMPURE = `dock load
  load <global:Date>, name date

task stamp
  take n, like number
  like number
  send back
    call add
      read n
      call date/now
`

function refusedFor(text: string): string[] {
  const built = compile({ file: 'main.tree', text })

  return built.ok ? [] : built.diagnostics.map(d => d.name)
}

function accepted(text: string): { ok: boolean; twins: number } {
  const built = compile({ file: 'main.tree', text })

  return { ok: built.ok, twins: built.ok ? (built.twins?.length ?? 0) : 0 }
}

const good = accepted(`${PURE}\ntwin double, name shift\n  take n\n  send back\n    call multiply\n      read n\n      code 2\n`)
ok('a pure twin of a pure task compiles, and the build carries it', good.ok && good.twins === 1, JSON.stringify(good))

const cases: [string, string, string][] = [
  ['a twin of no task', 'twin-unknown', `${PURE}\ntwin triple, name x\n  take n\n  send back, read n\n`],
  ['a twin of an impure task', 'twin-of-impure', `${IMPURE}\ntwin stamp, name x\n  take n\n  send back, read n\n`],
  ['a twin with other parameters', 'twin-signature', `${PURE}\ntwin double, name x\n  take m\n  send back, read m\n`],
  ['an impure twin', 'twin-impure', `${IMPURE}\n${PURE}\ntwin double, name x\n  take n\n  send back\n    call stamp\n      read n\n`],
  ['a twin that never ends', 'twin-loops', `${PURE}\ntask spin\n  take n, like number\n  like number\n  send back\n    call spin\n      read n\n\ntwin double, name x\n  take n\n  send back\n    call spin\n      read n\n`],
  ['an impure run-time check', 'guard-impure', `${IMPURE}\n${PURE}\ntwin double, name x\n  take n\n  hook test\n    call is-above\n      call stamp\n        read n\n      code 0\n  send back\n    call multiply\n      read n\n      code 2\n`],
  ['an undefined relaxation', 'ease-unknown', `${PURE}\ntwin double, name x\n  take n\n  ease anything-goes\n  send back\n    call multiply\n      read n\n      code 2\n`],
  [
    'two twins that call each other',
    'twin-cycle',
    `${PURE}\ntask halve\n  take n, like number\n  like number\n  send back\n    call divide\n      read n\n      code 2\n\ntwin double, name x\n  take n\n  send back\n    call halve\n      read n\n\ntwin halve, name y\n  take n\n  send back\n    call double\n      read n\n`,
  ],
]

for (const [label, want, text] of cases) {
  const got = refusedFor(text)
  ok(`${label} is refused as \`${want}\``, got.includes(want), `got ${JSON.stringify(got)}`)
}

// `mark trust` admits an impure twin: trust excuses a proof, never the check that it is admitted as trusted
const trusted = accepted(`${IMPURE}\n${PURE}\ntwin double, name x\n  take n\n  mark trust\n  send back\n    call stamp\n      read n\n`)
ok('an impure twin that says `mark trust` compiles', trusted.ok && trusted.twins === 1, JSON.stringify(trusted))

console.log(`\ntwin: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
