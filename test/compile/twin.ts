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
  note platform, name rust
  note trust
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
  ok('`note platform, name rust` names the target', JSON.stringify(dense?.platform) === '["rust"]', JSON.stringify(dense?.platform))
  ok('`note trust` is read', dense?.trust === true && tally?.trust === false)
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

console.log(`\ntwin: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
