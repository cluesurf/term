// `turn next` is the one `turn`: it goes on to the loop's next turn, and a bare `halt` leaves the loop. Any other word
// after `turn` compiled as a continue, with no message, until 2026-10-29 (term-self-host-001-0051, traps.md T038):
// `turn done` in a search ran on past its match. Now it is refused at the line, naming both spellings, on every
// backend alike (the mill refuses it before any emitter runs), and `turn next` still runs on all four.
// Run: npx tsx test/compile/turn-word.ts   (TURN_ONLY=typescript, rust, swift or kotlin runs one backend)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { compile } from '@term/make/code/compile/compile'
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

// a search that stops at its match with `halt`, and a count that skips with `turn next`
const searchWith = (word: string): string => `load @term/base/list
  find list

task first-big
  take xs, like list, like number
  like number
  save found, 0
  walk xs
    take x
    fork test, is-above x, 2
      hold
        save found, x
        ${word}
  back found

task count-small
  take xs, like list, like number
  like number
  save n, 0
  walk xs
    take x
    fork test, is-above x, 2
      hold
        turn next
    save n, add(n, 1)
  back n

task run
  like text
  save xs, make(list, 1, 5, 2, 9, 3)
  send back, <{first-big(xs)} {count-small(xs)}>
`

const dir = mkdtempSync(join(tmpdir(), 'term-turn-word-'))
const only = process.env.TURN_ONLY ?? ''

const refused = (word: string): string[] => {
  const built = compile(
    { file: join(dir, 'refused.tree'), text: searchWith(word) },
    { resolve: projectResolver(process.cwd(), 'node'), env: 'node' },
  )

  return built.ok ? [] : built.diagnostics.map(d => d.message)
}

for (const word of ['turn done', 'turn halt', 'turn stop']) {
  const messages = refused(word)
  const said = word.split(' ')[1]

  ok(
    `\`${word}\` is refused at its line, naming \`turn next\` and a bare \`halt\``,
    messages.some(m => m.includes(`\`turn ${said}\` is not a statement`) && m.includes('`turn next`') && m.includes('a bare `halt`')),
    messages.join(' | ') || 'it built',
  )
}

ok('`turn next` still builds', refused('halt').length === 0, refused('halt').join(' | '))

// the first number above 2 is 5 (the `halt` leaves the walk there), and two numbers are 2 or less
for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: searchWith('halt'), resolve: env => projectResolver(process.cwd(), env), dir, name: 'turns' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(
    `${backend}: a bare \`halt\` leaves the walk at the match and \`turn next\` skips a turn`,
    ran.form === 'ran' && ran.output === '5 2',
    ran.form === 'ran' ? `got ${JSON.stringify(ran.output)}` : `${ran.stage}: ${ran.reason}`,
  )
}

console.log(`\nturn-word: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
