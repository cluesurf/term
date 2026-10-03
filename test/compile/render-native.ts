// The renderer on three backends (native-dom-0004): the SAME Solid-style runtime (@term/site view/reactive and
// view/render) rendering the SAME component into the SAME in-memory host (dom/native/memory), compiled to TypeScript,
// Swift and Kotlin. The program mounts the counter under a root, fires `click` on its button eleven times, and returns
// the tree as HTML. Every backend must print the same HTML, and that HTML must show 11: a signal write reached the
// effect that read it, and the effect rewrote the text node, on each backend.
//
// The dom's `{platform}` slot is pinned to `memory` for all three, so TypeScript runs the identical host rather than
// the server's (`native/node`), and a difference can only be the backend.
// Rust joined on 2026-10-02 (native-dom-0020), once `mark shared` lowered there.
// RN_ONLY=typescript (or swift, kotlin, rust) runs one backend. Run: npx tsx test/compile/render-native.ts

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import type { NativeEnv } from '@term/make/code/compile/native'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'
import { emitRust } from '@term/make/code/compile/rust'
import { projectResolver } from '@term/call/code/make'
import type { Resolver } from '@term/make/code/compile/load'

let pass = 0
let fail = 0
let skip = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

function skipped(name: string, why: string): void {
  skip++
  console.log(`skip  ${name}  (${why})`)
}

function have(tool: string): boolean {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' })

    return true
  } catch {
    return false
  }
}

const ROOT = process.cwd()
const CLICKS = 11
const WANT = `<main><button>${CLICKS}</button></main>`

const PROGRAM = `load @term/site/code/test/site/counter-render
  find counter

load @term/site/code/dom/native/memory/dom
  find create-element
  find child-at
  find fire
  find serialize

task run
  like text
  save root
    call create-element
      bind tag, text <main>
  call counter
    read root
  save button
    call child-at
      read root
      code 0
  walk size
    bind base, code 0
    bind head, code ${CLICKS}
    hook next
      take site, name step
      call fire
        read button
        text <click>
  send back
    call serialize
      read root
`

// The same, written in the `view` DSL rather than as render calls, so the view lowering runs on each backend too,
// and with a `fork` the renderer must swap live: `low` at five clicks, `high` past ten. Two snapshots, joined by `|`.
const DSL_WANT = '<main><button>5</button><span>low</span></main>|<main><button>11</button><span>high</span></main>'
const DSL_PROGRAM = `load @term/site/code/view/reactive
  find make-signal
  find read-signal
  find write-signal

load @term/site/code/view/render
  find make-element
  find make-text
  find make-dynamic-text
  find attach-event
  find show

load @term/site/code/dom/dom
  find view
  find append

load @term/site/code/dom/native/memory/dom
  find create-element
  find child-at
  find fire
  find serialize

task shown
  take count, like signal number
  like text
  save value
    call read-signal
      bind self, read count
  send back, text <{{value}}>

view tally
  take host, like view
  save count
    call make-signal
      bind value, code 0
  view button
    seed click
      call write-signal
        bind self, read count
        bind value
          call add
            call read-signal
              bind self, read count
            code 1
    read
      call shown
        read count
  fork test
    hook test
      call is-above
        call read-signal
          bind self, read count
        code 10
    hook hold
      view span
        text <high>
    hook miss
      view span
        text <low>

task press
  take button, like view
  take times, like number
  walk size
    bind base, code 0
    bind head, read times
    hook next
      take site, name step
      call fire
        read button
        text <click>

task run
  like text
  save root
    call create-element
      bind tag, text <main>
  call tally
    read root
  save button
    call child-at
      read root
      code 0
  call press
    read button
    code 5
  save early
    call serialize
      read root
  call press
    read button
    code 6
  save late
    call serialize
      read root
  send back, text <{{early}}|{{late}}>
`

// A device trait as a signal (native-dom-0012): a view shows the colour scheme, the platform changes it, and only the
// node that read it is rewritten. The change comes through the memory host's `change-trait`, the way a platform's
// notification would reach the watcher.
const DEVICE_WANT = '<main><span>light</span></main>|<main><span>dark</span></main>'
const DEVICE_PROGRAM = `load @term/site/code/view/device
  find device-trait

load @term/site/code/view/native/memory/device
  find change-trait

load @term/site/code/view/reactive
  find read-signal

load @term/site/code/view/render
  find make-element
  find make-text
  find make-dynamic-text

load @term/site/code/dom/dom
  find view
  find append

load @term/site/code/dom/native/memory/dom
  find create-element
  find serialize

task scheme-text
  like text
  save scheme
    call device-trait
      text <color-scheme>
  send back
    call read-signal
      bind self, read scheme

view theme
  take host, like view
  view span
    read
      call scheme-text

task run
  like text
  save root
    call create-element
      bind tag, text <main>
  call theme
    read root
  save early
    call serialize
      read root
  call change-trait
    text <color-scheme>
    text <dark>
  save late
    call serialize
      read root
  send back, text <{{early}}|{{late}}>
`

// A replaced branch is disposed (reactive-bridge-0005): `show` mounts a branch whose dynamic text counts how often its
// effect runs. One write while it is mounted runs it again (2). Then the branch is swapped out, and three more writes
// to the signal it read must run it NO more times: a branch nobody can see must not be rewritten. A runtime that builds
// branches with no owner of their own answers 5.
const OWNED_WANT = '<main><span></span></main>|2'
const OWNED_PROGRAM = `load @term/site/code/view/reactive
  find make-signal
  find read-signal
  find write-signal

load @term/site/code/view/render
  find make-element
  find make-dynamic-text
  find show

load @term/site/code/dom/dom
  find view

load @term/site/code/dom/native/memory/dom
  find create-element
  find serialize

form tally
  mark shared
  link runs, like number

task run
  like text
  save root
    call create-element
      bind tag, text <main>
  save open
    call make-signal
      bind value, true
  save count
    call make-signal
      bind value, code 0
  save seen
    make tally
      bind runs, code 0
  call show
    bind host, read root
    bind when
      task is-open
        like boolean
        send back
          call read-signal
            bind self, read open
    bind then
      task build-open
        like view
        send back
          call make-dynamic-text
            bind source
              task count-text
                like text
                save seen/runs
                  call add
                    read seen/runs
                    code 1
                save value
                  call read-signal
                    bind self, read count
                send back, text <{value}>
    bind other
      task build-closed
        like view
        send back
          call make-element
            bind tag, text <span>
  call write-signal
    bind self, read count
    bind value, code 1
  call write-signal
    bind self, read open
    bind value, false
  call write-signal
    bind self, read count
    bind value, code 2
  call write-signal
    bind self, read count
    bind value, code 3
  call write-signal
    bind self, read count
    bind value, code 4
  save tree
    call serialize
      read root
  save runs, read seen/runs
  send back, text <{tree}|{runs}>
`

// The same for the two list renderers. Each item is a dynamic text reading `count`, and each list counts its effect
// runs. Both start at 2 items (2 runs each). The list drops `b`: the keyed list keeps `a`'s node and owner (no run) and
// disposes `b`'s, the plain list disposes both and rebuilds `a` (3). One write to `count` then runs only what is still
// mounted: `a` once in each (keyed 3, plain 4). A runtime that leaks answers keyed 4 and plain 6. A `b` element follows
// each list in its parent and must still follow it after the change: a runtime that re-appends a list's items to the
// parent puts them after the `b`.
const LIST_WANT = '<main>a1<b></b></main><main>a1<b></b></main>|3|4'
const LIST_PROGRAM = `load @term/site/code/view/reactive
  find make-signal
  find read-signal
  find write-signal

load @term/site/code/view/render
  find make-dynamic-text
  find render-each
  find render-each-keyed

load @term/site/code/dom/dom
  find view
  find append

load @term/site/code/dom/native/memory/dom
  find create-element
  find serialize

load @term/base/code/list
  find list
  find push

form tally
  mark shared
  link runs, like number

task make-letters
  take both, like boolean
  like list
    like text
  save out
    make list
  call push
    bind list, read out
    bind item, text <a>
  fork test
    hook test
      read both
    hook hold
      call push
        bind list, read out
        bind item, text <b>
  send back, read out

task make-item
  take item, like text
  take count, like signal number
  take seen, like tally
  like view
  send back
    call make-dynamic-text
      bind source
        task item-text
          like text
          save seen/runs
            call add
              read seen/runs
              code 1
          save value
            call read-signal
              bind self, read count
          send back, text <{item}{value}>

task run
  like text
  save keyed-root
    call create-element
      bind tag, text <main>
  save plain-root
    call create-element
      bind tag, text <main>
  save letters
    call make-signal
      bind value
        call make-letters
          bind both, true
  save count
    call make-signal
      bind value, code 0
  save keyed-seen
    make tally
      bind runs, code 0
  save plain-seen
    make tally
      bind runs, code 0
  call render-each-keyed
    bind host, read keyed-root
    bind items
      task keyed-items
        like list
          like text
        send back
          call read-signal
            bind self, read letters
    bind key
      task keyed-key
        take item, like text
        like text
        send back, read item
    bind build
      task keyed-build
        take item, like text
        like view
        send back
          call make-item
            bind item, read item
            bind count, read count
            bind seen, read keyed-seen
  call render-each
    bind host, read plain-root
    bind items
      task plain-items
        like list
          like text
        send back
          call read-signal
            bind self, read letters
    bind build
      task plain-build
        take item, like text
        like view
        send back
          call make-item
            bind item, read item
            bind count, read count
            bind seen, read plain-seen
  call append
    bind parent, read keyed-root
    bind child
      call create-element
        bind tag, text <b>
  call append
    bind parent, read plain-root
    bind child
      call create-element
        bind tag, text <b>
  call write-signal
    bind self, read letters
    bind value
      call make-letters
        bind both, false
  call write-signal
    bind self, read count
    bind value, code 1
  save keyed-tree
    call serialize
      read keyed-root
  save plain-tree
    call serialize
      read plain-root
  save keyed-runs, read keyed-seen/runs
  save plain-runs, read plain-seen/runs
  send back, text <{keyed-tree}{plain-tree}|{keyed-runs}|{plain-runs}>
`

// every env resolves the dom to the memory host, so the host is the same file on every backend
function pinned(env: NativeEnv): Resolver {
  const base = projectResolver(ROOT, env)

  return (importPath, fromFile) =>
    base(importPath.replace(/native\/\{platform\}\/(dom|device)$/, 'native/memory/$1'), fromFile)
}

const readRuntime = (file: string): string | undefined =>
  existsSync(file) ? readFileSync(file, 'utf8') : undefined

// `portable`: the case reaches the memory host only for `create-element` and `serialize`, which every host has, so it
// also runs on the server's DOM host (reactive-bridge-0004)
type Case = { name: string; program: string; want: string; portable?: boolean }

const CASES: Case[] = [
  { name: 'render calls', program: PROGRAM, want: WANT },
  { name: 'view dsl', program: DSL_PROGRAM, want: DSL_WANT },
  { name: 'device trait', program: DEVICE_PROGRAM, want: DEVICE_WANT },
  { name: 'owned branch', program: OWNED_PROGRAM, want: OWNED_WANT, portable: true },
  { name: 'owned items', program: LIST_PROGRAM, want: LIST_WANT, portable: true },
]

const dir = mkdtempSync(join(tmpdir(), 'term-render-native-'))

function build(env: NativeEnv, one: Case) {
  const entry = join(dir, `${one.name.replace(/ /g, '-')}.tree`)
  writeFileSync(entry, one.program)
  const result = compile({ file: entry, text: one.program }, { resolve: pinned(env), env })

  if (!result.ok) {
    throw new Error(`${env}: ${result.diagnostics.slice(0, 4).map(d => d.message).join(' | ')}`)
  }

  return result
}

function judge(label: string, one: Case, run: { status: number | null; stdout: string; stderr: string }): void {
  ok(
    `${label} (${one.name}): renders ${one.want}`,
    run.status === 0 && run.stdout.trim() === one.want,
    `exit ${run.status}: ${(run.stdout + run.stderr).slice(0, 400)}`,
  )
}

function compiles(label: string, args: string[]): boolean {
  try {
    execFileSync(args[0], args.slice(1), { stdio: 'pipe' })
    ok(`${label}: builds`, true)

    return true
  } catch (e) {
    // the errors, not the warnings in front of them
    const text = String((e as { stderr?: Buffer }).stderr ?? e)
    // `error:` (swiftc), `e: ` (kotlinc), `error[E0308]:` (rustc), and rustc's ` --> file:line` under each
    const errors = text.split('\n').filter(line => /error:|^e: |^error\[|^\s+--> /.test(line))
    ok(`${label}: builds`, false, (errors.length > 0 ? errors.join('\n') : text).slice(0, 1600))

    return false
  }
}

function runTypeScript(one: Case): void {
  const result = build('node', one)
  const prelude = nativePrelude(result.program, 'node', readRuntime, result.typescript)
  const file = join(dir, `${one.name.replace(/ /g, '-')}.ts`)
  writeFileSync(file, `${prelude}\n${result.typescript}\nconsole.log(run())\n`)
  judge('typescript', one, spawnSync('npx', ['tsx', file], { encoding: 'utf8' }))
}

function runSwift(one: Case): void {
  if (!have('swiftc')) {
    return skipped('swift: render', 'swiftc not installed')
  }

  const result = build('swift', one)
  const swift = emitSwift(result.program)
  const prelude = nativePrelude(result.program, 'swift', readRuntime, swift)
  const stem = join(dir, `${one.name.replace(/ /g, '-')}-swift`)
  writeFileSync(`${stem}.swift`, ['import Foundation', prelude, swift, 'print(run())', ''].join('\n'))

  if (compiles(`swift (${one.name})`, ['swiftc', '-o', stem, `${stem}.swift`])) {
    judge('swift', one, spawnSync(stem, [], { encoding: 'utf8' }))
  }
}

function runKotlin(one: Case): void {
  if (!have('kotlinc') || !have('java')) {
    return skipped('kotlin: render', 'kotlinc/java not installed')
  }

  const result = build('kotlin', one)
  const kotlin = emitKotlin(result.program)
  const prelude = nativePrelude(result.program, 'kotlin', readRuntime, kotlin)
  const stem = join(dir, `${one.name.replace(/ /g, '-')}-kotlin`)
  writeFileSync(`${stem}.kt`, `${hoistKotlinImports([prelude, kotlin, 'fun main() { println(run()) }'].join('\n'))}\n`)

  if (compiles(`kotlin (${one.name})`, ['kotlinc', `${stem}.kt`, '-include-runtime', '-nowarn', '-d', `${stem}.jar`])) {
    judge('kotlin', one, spawnSync('java', ['-jar', `${stem}.jar`], { encoding: 'utf8' }))
  }
}

// Rust (native-dom-0020): the memory host holds its nodes in `mark shared` forms, which Rust lowers to an
// `Rc<RefCell<..>>` handle, so a node appended under the root is the same node the effect rewrites
function runRust(one: Case): void {
  if (!have('rustc')) {
    return skipped('rust: render', 'rustc not installed')
  }

  const result = build('rust', one)
  const rust = emitRust(result.program)
  const prelude = nativePrelude(result.program, 'rust', readRuntime, rust)
  const stem = join(dir, `${one.name.replace(/ /g, '-')}-rust`)
  writeFileSync(`${stem}.rs`, [prelude, rust, 'fn main() { println!("{}", run()); }', ''].join('\n'))

  if (compiles(`rust (${one.name})`, ['rustc', '-A', 'warnings', '-o', stem, `${stem}.rs`])) {
    judge('rust', one, spawnSync(stem, [], { encoding: 'utf8' }))
  }
}

// The DOM runtime beside the retained tree (reactive-bridge-0004): a portable case with its host load pointed at the
// public dom module, unpinned, so `{platform}` resolves to the server's DOM host (dom/native/node) as SSR does. The
// output must be the memory host's, byte for byte, after the same signal writes.
function runDom(one: Case): void {
  if (!one.portable) {
    return
  }

  const program = one.program.replace('@term/site/code/dom/native/memory/dom', '@term/site/code/dom/dom')
  const entry = join(dir, `${one.name.replace(/ /g, '-')}-dom.tree`)
  writeFileSync(entry, program)
  const result = compile({ file: entry, text: program }, { resolve: projectResolver(ROOT, 'node'), env: 'node' })

  if (!result.ok) {
    throw new Error(`dom: ${result.diagnostics.slice(0, 4).map(d => d.message).join(' | ')}`)
  }

  const prelude = nativePrelude(result.program, 'node', readRuntime, result.typescript)
  const file = join(dir, `${one.name.replace(/ /g, '-')}-dom.ts`)
  writeFileSync(file, `${prelude}\n${result.typescript}\nconsole.log(run())\n`)
  const ran = spawnSync('npx', ['tsx', file], { encoding: 'utf8' })
  // the SSR serializer indents an element that holds elements, a line and two spaces per level; the memory host
  // writes none. That is layout of the HTML text, not of the tree, so it is taken out before the trees are compared
  judge('server dom', one, { ...ran, stdout: ran.stdout.replace(/>\n *</g, '><') })
}

const only = process.env.RN_ONLY ?? ''

for (const one of CASES) {
  for (const [name, run] of [['typescript', runTypeScript], ['dom', runDom], ['swift', runSwift], ['kotlin', runKotlin], ['rust', runRust]] as const) {
    if (!only || only === name) {
      try {
        run(one)
      } catch (e) {
        ok(`${name} (${one.name}): compiles`, false, String(e).slice(0, 800))
      }
    }
  }
}

console.log(`\nrender-native: ${pass} pass, ${fail} fail, ${skip} skipped`)

if (fail > 0) {
  process.exit(1)
}
