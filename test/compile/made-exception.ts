// A `make` of a declared exception form anywhere but as the value directly under a `halt` is refused as
// `made-exception` on every backend (decision 087 of note/project/term/self-host/change/001-finish-self-host, item
// term-self-host-001-0474). An exception value is a raised occurrence: `host`, `form`, `code`, `time` and `link` are
// filled only at a raise, so a made record of the form read `made/form` and `made/link/step` as text that was never
// filled (undefined on TypeScript, a default natively), and passing one where `exception` is expected failed as the
// misleading "expected exception, found wrapped". The two repros of item 0460 (a parameter and a list item, then a
// field and a list) are refused by name on all four backends, and the written-right shape (`halt wrapped` with its
// `bind step`, caught by a guard and passed on) still builds and runs on all four.
// Run: npx tsx test/compile/made-exception.ts   (MADE_ONLY=typescript, rust, swift or kotlin runs one backend)

import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { compile } from '@term/make/code/compile/compile'
import type { NativeEnv } from '@term/make/code/compile/native'
import { BACKENDS, runOn } from './shared/run-on'
import type { Backend } from './shared/run-on'

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

const HEAD = `load @term/base/exception
  find exception

load @term/base/maybe
  find maybe

load @term/base/list
  find list
  find join

form wrapped
  like exception
    bind note, <Wrapped>
    link step, like text

`

// item 0460's q2: a made record passed to a parameter typed exception, and as a list item
const AS_PARAMETER = `${HEAD}task describe
  take e, like exception
  like text
  back <{e/form}:{e/note}:{e/link/step}>

task count-told
  take all, like list, like exception
  like text
  save forms, make list
  walk all
    take one
    push(forms, one/form)
  back <{all/length}:{join(forms, <,>)}>

task run
  like text
  save made
    make wrapped
      bind step, <made>
  back <{describe(made)}/{count-told(make list(made, made))}>
`

// item 0460's q3: a made record put in a field typed exception and pushed to a list
const AS_FIELD = `${HEAD}form holder
  link one, like exception
  link all, like list, like exception

task run
  like text
  save made
    make wrapped
      bind link
        make wrapped-link
          bind step, <made>
  save all, make list
  push(all, made)
  save h
    make holder
      bind one, made
      bind all, all
  back <{made/form}:{h/one/form}:{all/length}>
`

// the same made record read only by itself: no place typed exception, so before 0474 it built, and its form and
// link read nothing
const READ_ALONE = `${HEAD}task run
  like text
  save made
    make wrapped
      bind step, <made>
  back <{made/form}:{made/link/step}>
`

// the written-right shape: raised with halt, caught by a guard, passed on
const RAISED = `${HEAD}task boom
  take n, like number
  like number
  fork test, is-above(n, 3)
    hold
      halt wrapped
        bind step, <outer>
  back n

task describe
  take e, like exception
  like text
  back <{e/form}:{e/note}:{e/link/step}>

task count-told
  take all, like list, like exception
  like text
  save forms, make list
  walk all
    take one
    push(forms, one/form)
  back <{all/length}:{join(forms, <,>)}>

task run
  like text
  fork
    mark unsafe
    save x, boom(9)
    back <none>
  halt take
    take problem
    save kept, make list
    push(kept, problem)
    back <{describe(problem)}/{count-told(kept)}/{count-told(make list(problem, problem))}>
  back <none>
`

const EXPECTED = 'wrapped:Wrapped:outer/1:wrapped/2:wrapped,wrapped'

const REFUSED: Record<string, string> = {
  'a parameter and a list item': AS_PARAMETER,
  'a field and a list': AS_FIELD,
  'a read of its own fields': READ_ALONE,
}

const ENV: Record<Backend, NativeEnv> = {
  typescript: 'node',
  rust: 'rust',
  swift: 'swift',
  kotlin: 'kotlin',
}

const HERE =
  import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const root = mkdtempSync(join(tmpdir(), 'term-made-exception-'))
mkdirSync(join(root, 'link/@term'), { recursive: true })
mkdirSync(join(root, 'code'), { recursive: true })
symlinkSync(join(TERM, 'deck/base'), join(root, 'link/@term/base'))
writeFileSync(
  join(root, 'deck.tree'),
  'deck @probe/made-exception\n  code <0.0.0>\n',
)
const out = join(root, 'out')
mkdirSync(out, { recursive: true })

const only = process.env.MADE_ONLY

for (const backend of BACKENDS.filter(one => !only || one === only)) {
  const env = ENV[backend]

  for (const [label, program] of Object.entries(REFUSED)) {
    const result = compile(
      {
        file: join(root, 'code', 'made-exception.tree'),
        text: program,
      },
      {
        resolve: projectResolver(root, env),
        env,
        leanOf: () => true,
      },
    )
    const said = result.ok
      ? 'compiled'
      : result.diagnostics
          .map(d => `${d.name}: ${d.message}`)
          .join(' | ')
    ok(
      `${backend}: a made exception record used as ${label} is refused as made-exception`,
      !result.ok &&
        result.diagnostics.some(
          d =>
            d.name === 'made-exception' &&
            d.message.includes('"wrapped"') &&
            d.message.includes('`halt wrapped`'),
        ),
      said,
    )
    ok(
      `${backend}: ${label}: the old type-mismatch is not what is said`,
      !result.diagnostics.some(d =>
        d.message.includes('found wrapped'),
      ),
      said,
    )
  }

  const ran = runOn({
    backend,
    program: RAISED,
    resolve: one => projectResolver(root, one),
    dir: out,
    name: `made-exception-${backend}`,
    file: join(root, 'code', 'raised.tree'),
  })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(
    `${backend}: halt wrapped with its bind step, caught and passed on, builds and runs`,
    ran.form === 'ran' && ran.output === EXPECTED,
    ran.form === 'ran'
      ? `got ${JSON.stringify(ran.output)}`
      : `${ran.stage}: ${ran.reason.slice(0, 900)}`,
  )
}

console.log(`\nmade-exception: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
