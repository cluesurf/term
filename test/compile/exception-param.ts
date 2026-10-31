// A value typed `exception` is the carrier a caught raise is, on every backend (decision 085 of
// note/project/term/self-host/change/001-finish-self-host, item term-self-host-001-0460): a caught raise passed to a
// task parameter typed `exception`, and lists of them (a local list and a list literal) passed to one typed a list of
// exceptions, read the raise's form and a link prop alike on TypeScript, Rust, Swift and Kotlin. Before 0460 the
// native backends spelled the parameter as the form's struct generic over its props (rustc E0308 and E0283, swiftc
// and kotlinc "could not infer T"). A backend whose toolchain is absent is skipped.
// Run: npx tsx test/compile/exception-param.ts (from deck/term/deck/term)

import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
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

const PROGRAM = `load @term/base/exception
  find exception

load @term/base/maybe
  find maybe

load @term/base/list
  find list

form wrapped
  like exception
    bind note, <Wrapped>
    link step, like text

task boom
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

const HERE =
  import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const root = mkdtempSync(join(tmpdir(), 'term-exception-param-'))
mkdirSync(join(root, 'link/@term'), { recursive: true })
mkdirSync(join(root, 'code'), { recursive: true })
symlinkSync(join(TERM, 'deck/base'), join(root, 'link/@term/base'))
writeFileSync(
  join(root, 'deck.tree'),
  'deck @probe/exception-param\n  code <0.0.0>\n',
)
const out = join(root, 'out')
mkdirSync(out, { recursive: true })
const file = join(root, 'code', 'exception-param.tree')

for (const backend of BACKENDS) {
  const ran = runOn({
    backend,
    program: PROGRAM,
    resolve: env => projectResolver(root, env),
    dir: out,
    name: `exception-param-${backend}`,
    file,
  })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(
    `${backend}: a caught raise passes to a parameter typed exception and to a list of them`,
    ran.form === 'ran' && ran.output === EXPECTED,
    ran.form === 'ran'
      ? `got ${JSON.stringify(ran.output)}`
      : `${ran.stage}: ${ran.reason.slice(0, 900)}`,
  )
}

console.log(`\nexception-param: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
