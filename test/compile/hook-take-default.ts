// A hook take's default reaches its route, whichever literal spells it. The bind mill reads a lone word under `bind` as
// the bind's NAME (`bind <name>, <value>`), so `bind true` minted a bind named `true` with no value, routeOf found no
// seed, and the take lost its default in silence: the console's `motion` (yargs default true) and hold's `cache`
// (term-compiler-0065, cli-in-term traps.md). `bind true` / `bind false` are kept as a flag, the same fallback
// `bind code true` gives, and any other lone word under a take's `bind` is refused, naming the literal spellings.
//
// Run: npx tsx test/compile/hook-take-default.ts

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

const console_ = (takes: string): string =>
  `hook tool\n${takes}  hook run\n    task run\n\ntask run\n  like text\n\n  send back, <z>\n`

type Take = {
  name: string
  fallback?: { form: string; value: unknown }
}

const takesOf = (text: string): Take[] | string => {
  const out = compile(
    { file: '/gate/code/line/base.tree', text },
    { roleOf: () => 'call' },
  )

  if (!out.ok) {
    return out.diagnostics.map(d => d.message).join(' | ')
  }

  const dock = out.program.find(s => s.form === 'dock')

  return dock && 'route' in dock
    ? (dock.route.takes as Take[])
    : 'no route'
}

const takes = takesOf(
  console_(
    [
      '  take one\n    like boolean\n    bind true\n',
      '  take two\n    like boolean\n    bind false\n',
      '  take three\n    like boolean\n    bind code true\n',
      '  take four\n    like text\n    bind <line>\n',
      '  take five\n    like number\n    bind 3000\n',
    ].join(''),
  ),
)

if (typeof takes === 'string') {
  ok('the console builds', false, takes)
} else {
  const fallback = (name: string) =>
    JSON.stringify(takes.find(take => take.name === name)?.fallback)

  ok(
    '`bind true` keeps its default',
    fallback('one') === '{"form":"flag","value":true}',
    fallback('one'),
  )
  ok(
    '`bind false` keeps its default',
    fallback('two') === '{"form":"flag","value":false}',
    fallback('two'),
  )
  ok(
    '`bind code true` still keeps its default',
    fallback('three') === '{"form":"flag","value":true}',
    fallback('three'),
  )
  ok(
    '`bind <line>` still keeps its default',
    fallback('four') === '{"form":"text","value":"line"}',
    fallback('four'),
  )
  ok(
    '`bind 3000` still keeps its default',
    fallback('five') === '{"form":"number","value":3000}',
    fallback('five'),
  )
}

// a lone word that is no literal is no default either: refused, never dropped
const refused = takesOf(
  console_('  take mode\n    like text\n    bind fast\n'),
)

ok(
  'a lone word default is refused, naming the literal spellings',
  typeof refused === 'string' && refused.includes('bind <fast>'),
  typeof refused === 'string' ? refused : JSON.stringify(refused),
)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
