// `term roll exception --path`: under each exception, one call path from every task that can raise it to the site
// that raises it, from the `via` edges the checker's raise sets record. A task that raises directly has an empty
// chain; a task that reaches the raise through callees lists them in order. Run: npx tsx test/call/roll.ts

import { compile } from '@term/make/code/compile/compile'
import { showRoll } from '@term/make/code/compile/roll'

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

// the stdlib exception form stands in, the way test/compile/exception.ts writes it, so the test needs no resolver.
// `outer` reaches `limit` only through `middle`, which reaches it through `inner`, which raises it
const PROGRAM = `form exception
  head p
  link host, like text
  link form, like text
  link note, like text
  link code, like text
  link time, like number
  link link, like p

task exception-code
  like text
  send back, text <kvmtnhbs-rzdxfwlc-mnbdtkhs-fvzxcwlr>

task exception-time
  like number
  send back, code 7

form limit
  like exception
    bind note, <Too many>
    link count, like number

task inner
  take n, like number
  like number
  fork test
    hook test
      call is-above
        read n
        code 3
    hook hold
      halt limit
        bind count, read n
  send back, read n

task middle
  take n, like number
  like number
  send back
    call inner
      read n

task outer
  take n, like number
  like number
  send back
    call middle
      read n
`

const result = compile({ file: 'main.tree', text: PROGRAM }, { roll: true })

ok('the program compiles with a roll', result.ok && result.roll !== undefined, result.ok ? '' : result.diagnostics.map(d => d.message).join(' | '))

if (!result.ok || !result.roll) {
  console.log(`\nroll: ${pass} pass, ${fail} fail`)
  process.exit(1)
}

const task = (name: string) => result.roll!.task.find(t => t.name === name) as { halt?: string[]; path?: Record<string, string[]> } | undefined

ok('every task on the chain raises limit', ['inner', 'middle', 'outer'].every(n => task(n)?.halt?.includes('limit')))
ok('the direct raiser has an empty path', JSON.stringify(task('inner')?.path?.limit) === '[]', JSON.stringify(task('inner')?.path))
ok('one hop lists the callee', JSON.stringify(task('middle')?.path?.limit) === '["inner"]', JSON.stringify(task('middle')?.path))
ok('two hops list them in call order', JSON.stringify(task('outer')?.path?.limit) === '["middle","inner"]', JSON.stringify(task('outer')?.path))

const shown = showRoll(result.roll, 'exception', { path: true })
ok('--path prints the chain under the exception', shown.includes('path @local/outer > middle > inner'), shown)
ok('--path prints the direct raiser with no chain', /path @local\/inner\n/.test(shown + '\n'), shown)

const plain = showRoll(result.roll, 'exception')
ok('without --path the exception entry is unchanged', !plain.includes('path '), plain)

const tasks = showRoll(result.roll, 'task', { path: true })
ok('a task shows its own path under --path', tasks.includes('path limit, outer > middle > inner'), tasks)

// a kind a deck declares: `roll metric` / `like metric`, and every top-level constant of that form is an entry
const KIND = `form metric
  link name, like text
  link unit, like text

roll metric
  like metric

host request-count
  make metric
    bind name, text <requests>
    bind unit, text <count>

host latency
  make metric
    bind name, text <latency>
    bind unit, text <ms>

host not-a-metric, code 3
`

const kinds = compile({ file: 'k.tree', text: KIND }, { roll: true })
ok('a declared kind compiles with a roll', kinds.ok && kinds.roll !== undefined, kinds.ok ? '' : kinds.diagnostics.map(d => d.message).join(' | '))
const declared = kinds.ok ? kinds.roll?.kind ?? [] : []
ok('the roll lists the declared kind with its form', declared.length === 1 && declared[0]!.name === 'metric' && declared[0]!.like === 'metric', JSON.stringify(declared))
const metrics = kinds.ok ? kinds.roll?.metric ?? [] : []
ok('every constant of the form is an entry on the kind', metrics.map(m => m.name).sort().join(',') === 'latency,request-count', JSON.stringify(metrics))
ok('a constant of another type is not', !metrics.some(m => m.name === 'not-a-metric'))
ok('an entry carries the constant it refers to', metrics.every(m => m.ref === m.name && m.kind === 'metric'), JSON.stringify(metrics))
const shownKind = kinds.ok && kinds.roll ? showRoll(kinds.roll, 'metric') : ''
ok('`term roll metric` prints the entries', shownKind.includes('metric @local/request-count') && shownKind.includes('metric @local/latency'), shownKind)
const missingLike = compile({ file: 'm.tree', text: 'roll metric\n' })
ok('a roll without its form is refused', !missingLike.ok && missingLike.diagnostics.some(d => d.message.includes('needs the form of its entries')), missingLike.ok ? '' : missingLike.diagnostics.map(d => d.message).join(' | '))

console.log(`\nroll: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
