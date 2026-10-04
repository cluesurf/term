// A `make pattern, <...>` literal is read when the program is built (check/patterns.ts, regex-engine-0007): refused
// when @term/base/pattern's reader refuses it, warned when it lands on the backtracking tier, naming why, and silent
// otherwise. Each spelling of a literal is asked: positional in a task, `bind text` by name, a top-level `host`. A
// text built at run time is the program's to handle, and so is a form of the same name a program declares itself.
//
// Run: npx tsx test/compile/pattern-literal.ts

import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'

let pass = 0
let fail = 0

const program = (head: string, body: string) => `load @term/base/pattern
  find pattern
  find matches
${head}
task run
  take input, like text
  like boolean
${body}
`

type Want = { builds: boolean; said: string[] }

const CASES: [string, string, string, Want][] = [
  ['a pattern that reads, on tier B', '', '  send back, call(matches, make(pattern, text(<a*b>)), read(input))', { builds: true, said: [] }],
  ['a pattern that reads, native', '', '  send back, call(matches, make(pattern, text(<\\d+>)), read(input))', { builds: true, said: [] }],
  [
    'a back reference',
    '',
    '  send back, call(matches, make(pattern, text(<(\\w)\\1>)), read(input))',
    { builds: true, said: ['pattern-backtracks: `(\\w)\\1` needs a backtracking matcher, because of the back reference to group 1'] },
  ],
  [
    'an atomic group, bound by name',
    '',
    '  save p\n    make pattern\n      bind text, text <(?\\>ab|a)c>\n  send back, call(matches, read(p), read(input))',
    { builds: true, said: ['pattern-backtracks: `(?>ab|a)c` needs a backtracking matcher, because of an atomic group'] },
  ],
  [
    'a possessive repetition in a top-level host',
    'host fixed, make pattern, <(ab)++c>\n',
    '  send back, call(matches, read(fixed), read(input))',
    { builds: true, said: ['pattern-backtracks: `(ab)++c` needs a backtracking matcher, because of a possessive repetition'] },
  ],
  // the analysis takes both out of tier C, so neither is warned: `(a)\1` is `(a)a`, `[a-z]++` a greedy run and a lookahead
  ['a back reference the analysis replaces', '', '  send back, call(matches, make(pattern, text(<(a)\\1>)), read(input))', { builds: true, said: [] }],
  ['a possessive repetition the analysis replaces', '', '  send back, call(matches, make(pattern, text(<[a-z]++x>)), read(input))', { builds: true, said: [] }],
  [
    'a count whose most is below its least',
    '',
    '  send back, call(matches, make(pattern, text(<a\\{3,1\\}>)), read(input))',
    { builds: false, said: ['pattern-mismatch: `a{3,1}` is not a pattern: a count whose most is below its least, at code point 1'] },
  ],
  [
    'a property that does not exist',
    '',
    '  send back, call(matches, make(pattern, text(<\\p\\{Nope\\}>)), read(input))',
    { builds: false, said: ['pattern-mismatch: `\\p{Nope}` is not a pattern'] },
  ],
  ['a text built at run time', '', '  send back, call(matches, make(pattern, read(input)), read(input))', { builds: true, said: [] }],
]

for (const [label, head, body, want] of CASES) {
  const file = join(process.cwd(), 'test', 'compile', `pattern-literal-${label.replace(/[^a-z]+/g, '-')}.tree`)
  const result = compile({ file, text: program(head, body) }, { resolve: withNativeEnv('node', stdlibResolver()!) })
  const said = (result.ok ? result.warnings : result.diagnostics).filter(d => d.name.startsWith('pattern')).map(d => `${d.name}: ${d.message}`)
  // a message is held by its opening, so its explanation can be reworded without editing every case
  const agrees =
    result.ok === want.builds && said.length === want.said.length && want.said.every((opening, i) => said[i]!.startsWith(opening))

  if (agrees) {
    pass++
    console.log(`ok    ${label}`)
  } else {
    fail++
    const other = result.ok ? '' : result.diagnostics.filter(d => !d.name.startsWith('pattern')).map(d => `${d.name}: ${d.message}`).join('; ')
    console.log(`FAIL  ${label}\n        got  ${result.ok ? 'builds' : 'refused'} ${JSON.stringify(said)} ${other}\n        want ${want.builds ? 'builds' : 'refused'} ${JSON.stringify(want.said)}`)
  }
}

// a form of its own named `pattern`, with no stdlib pattern in the program: its text is nobody's pattern
{
  const file = join(process.cwd(), 'test', 'compile', 'pattern-literal-own-form.tree')
  const text = `form pattern\n  slot text, like text\n\ntask run\n  like text\n  save p, make pattern, <a\\{3,1\\}>\n  send back, read p/text\n`
  const result = compile({ file, text }, { resolve: withNativeEnv('node', stdlibResolver()!) })
  const said = (result.ok ? result.warnings : result.diagnostics).filter(d => d.name.startsWith('pattern'))

  if (result.ok && said.length === 0) {
    pass++
    console.log('ok    a form of its own named pattern')
  } else {
    fail++
    console.log(`FAIL  a form of its own named pattern\n        got  ${result.ok ? 'builds' : 'refused'} ${JSON.stringify(said.map(d => d.message))}`)
  }
}

console.log(`\npattern-literal: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
