// View codegen test: compile a counter view through the compiler every build uses (parse, mill, resolve, check, then
// ts-emit.tree's emit-zone onto @term/site's render runtime), then click it on the in-memory dom and read the count
// back. Run: npx tsx test/zone/compile.ts

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { projectResolver } from '@term/call/code/make'
import type { Resolver } from '@term/make/code/compile/load'

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

// the count before any click, after one, and after three, each the whole mounted tree
const WANT = [
  '<main><button>0</button></main>',
  '<main><button>1</button></main>',
  '<main><button>3</button></main>',
].join('|')

const PROGRAM = `load @term/site/code/view/reactive
  find make-signal
  find read-signal
  find write-signal

load @term/site/code/view/render
  find make-element
  find make-text
  find make-dynamic-text
  find attach-event

load @term/site/code/dom/dom
  find view
  find append

load @term/site/code/dom/native/memory/dom
  find create-element
  find child-at
  find fire
  find serialize

task count-text
  take count, like signal
  like text
  save n
    call read-signal
      bind self, read count
  send back, text <{n}>

task bump
  take count, like signal
  save n
    call read-signal
      bind self, read count
  call write-signal
    bind self, read count
    bind value
      call add
        read n
        code 1

view counter
  take host, like view
  save count
    call make-signal
      bind value, code 0
  view button
    seed click
      call bump
        read count
    read
      call count-text
        read count

task click
  take root, like view
  call fire
    call child-at
      read root
      code 0
    text <click>

task run
  like text
  save root
    call create-element
      bind tag, text <main>
  call counter
    read root
  save before
    call serialize
      read root
  call click
    read root
  save once
    call serialize
      read root
  call click
    read root
  call click
    read root
  save thrice
    call serialize
      read root
  send back, text <{before}|{once}|{thrice}>
`

// the dom and view modules on the in-memory platform, so the program runs under node with no browser
function pinned(env: string): Resolver {
  const base = projectResolver(process.cwd(), env)

  return (importPath, fromFile) =>
    base(
      importPath.replace(
        /native\/\{platform\}\/(dom|view)$/,
        'native/memory/$1',
      ),
      fromFile,
    )
}

const dir = mkdtempSync(join(tmpdir(), 'term-zone-compile-'))
try {
  const entry = join(dir, 'counter.tree')
  writeFileSync(entry, PROGRAM)
  const result = compile(
    { file: entry, text: PROGRAM },
    { resolve: pinned('node'), env: 'node' },
  )
  ok(
    'the counter view compiles',
    result.ok,
    result.ok
      ? ''
      : [...new Set(result.diagnostics.map(d => d.message))]
          .slice(0, 6)
          .join(' | '),
  )

  if (result.ok) {
    const typescript = result.typescript
    ok(
      'emits the view as a component function',
      /export function counter\(host/.test(typescript),
    )
    ok(
      'emits the signal on the render runtime',
      /makeSignal\(/.test(typescript),
    )
    ok(
      'emits the click handler as an event',
      /attachEvent\([^\n]*"click"/.test(typescript),
    )
    ok(
      'emits the count as a reactive text node',
      /makeDynamicText\(\(\) =>/.test(typescript),
    )

    const readRuntime = (file: string): string | undefined =>
      existsSync(file) ? readFileSync(file, 'utf8') : undefined
    const file = join(dir, 'counter.ts')
    writeFileSync(
      file,
      `${nativePrelude(result.program, 'node', readRuntime, typescript)}\n${typescript}\nconsole.log(run())\n`,
    )
    const ran = spawnSync('npx', ['tsx', file], { encoding: 'utf8' })
    const read = ran.stdout.trim()
    const [before, once, thrice] = read.split('|')
    ok(
      'the program runs',
      ran.status === 0,
      `exit ${ran.status}: ${(ran.stdout + ran.stderr).slice(0, 400)}`,
    )
    ok('initial state', before === WANT.split('|')[0], String(before))
    ok('after one click', once === WANT.split('|')[1], String(once))
    ok('after three clicks', thrice === WANT.split('|')[2], String(thrice))
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\nzone-compile: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
