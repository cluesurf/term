// The view lowering's runtime calls bind as render.tree binds them (beat-term-0043, decision D020). A merged native
// build splits a task two files define by file (`append`, defined by @term/base/file and by the toolkit dom, becomes
// `append__in0_<k>`), and the lowering ran after that and still wrote the plain `append`: swiftc said
// `cannot find 'append' in scope`. Four cases, none of which RUNS an app or touches a simulator: the Swift is only
// typechecked, for the iPhone simulator SDK and for macOS.
//
//   A  the defect: a view and @term/base/file in one program
//   B  the entry file defines a task `append` of its own: it keeps its name, the lowering calls the dom's
//   B2 the entry's `append` takes views, so a wrong binding still compiles: only the text witness can see it
//   C  nothing is split: no @term/base/file, the lowering calls the dom's plain `append`
//   D  the map: disambiguateOverloads leaves runtimeBound naming append, remove and replace by the dom's renamed
//      names and make-element by itself
//
// and one for the simplifier (beat-term-0055, review 0045 finding 1):
//
//   E  the entry defines `make-text` and `write-attribute`, render.tree's own one-line forwarders: the build renames
//      render's, and `simplify` kept no root for a renamed name, so it deleted them as dead forwarders before the
//      lowering called them. Every lowered call in `screen` names the bound name, and the Swift defines it
//
// and one for the runtime's file (beat-term-0058, review 0045 finding 4):
//
//   F  the app owns a `view/render.tree` the entry loads before the toolkit: bind-runtime finds the runtime by
//      resolving `@term/site/view/render`, not by the first path ending `/view/render.tree`
//   F2 the same app loading only its own `./view/render` (beat-term-0064): the walk still gives the runtime
//
// Run: sh tmp/beat-tsx.sh test/compile/view-runtime-split.ts
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { emitSwift } from '@term/make/code/compile/swift'
import { runtimeBound } from '@term/make/code/check/overload'
import { projectResolver } from '@term/call/code/make'
import { SWIFT_MODULE } from '@term/call/code/cask'
import { existsSync, readFileSync } from 'node:fs'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info.slice(-1600)}`)
  }
}

const ROOT = process.cwd()
const HERE = mkdtempSync(join(tmpdir(), 'term-view-runtime-split-'))

const HEAD = `load @term/site/dom/dom
  find view

load @term/site/dom/native/toolkit/dom
  find run-app

load @term/site/view/native/toolkit/host
  find mount-app
`

const FILE = `
load @term/base/file
  find copy, name copy-file
`

const VIEW = `
view screen
  take host, like view
  view span
    text <hello>
`

const COPY = `
task copy-it
  mark async
  call copy-file
    text </a>
    text </b>
`

// the entry's own `append`, called once
const OWN = `
task append
  take first, like text
  take second, like text
  like text
  send back, read first

task use-append
  like text
  send back
    call append
      text <Repro>
      text <b>
`

// `use` is the lines main runs first: the tasks under test must be reachable and their result used, or the build
// drops them
const boot = (use: string, title = '    text <Repro>\n'): string => `
task main
${use}  call mount-app
    task route
      take host, like view
      take path, like text
      call screen
        read host
${title}  call run-app
`

const caseA = HEAD + FILE + VIEW + COPY + boot('  call copy-it\n')
const caseB = HEAD + FILE + VIEW + COPY + OWN + boot('  call copy-it\n', '    call use-append\n')
const caseC = HEAD + VIEW + boot('')

// B2: the entry's own `append` takes views, so a wrong binding (the lowering calling the entry's) still compiles and
// only a text witness can see it. The task has a statement, or it is a signature and emits a `fatalError` stub
const OWN_VIEWS = `
task append
  take parent, like view
  take child, like view
  save nothing, 0
`

const caseB2 =
  HEAD +
  VIEW +
  OWN_VIEWS +
  `
task main
  call mount-app
    task route
      take host, like view
      take path, like text
      call append
        read host
        read host
      call screen
        read host
    text <Repro>
  call run-app
`

// E: the entry's own `make-text` and `write-attribute` (render.tree's names, other arities), and a view that makes an
// element with an attribute and a text
const VIEW_ATTRIBUTE = `
view screen
  take host, like view
  view span
    bind title, text <t>
    text <hello>
`

const OWN_FORWARDERS = `
task make-text
  take first, like text
  take second, like text
  like text
  send back, text <{first}{second}>

task write-attribute
  take first, like text
  take second, like text
  take third, like text
  like text
  send back, read first

task use-forwarders
  like text
  send back
    call make-text
      text <a>
      call write-attribute
        text <a>
        text <b>
        text <c>
`

const caseE = HEAD + VIEW_ATTRIBUTE + OWN_FORWARDERS + boot('', '    call use-forwarders\n')

// F: the app owns a `view/render.tree` (beat-term-0058, review 0045 finding 4). It is loaded BEFORE the toolkit, so it
// comes first in the merged program, and bind-runtime took the first file ending `/view/render.tree` for the runtime:
// every runtime name then bound against the app's file, which reaches none of them, and the lowering called a plain
// `append` the build had renamed. The runtime's file is found by resolving `@term/site/view/render`. A relative load
// must stay inside the project root (projectResolver), so the case lives under `tmp/`, not the system temp folder
const APP_RENDER = `
task shout
  take first, like text
  like text
  send back, text <{first}!>
`

// F also loads the runtime by its package path, as the app did before beat-term-0064. F2 below loads only the app's own
// `./view/render`: walk-one skips an implicit runtime by its resolved file (D026), so the runtime is still given
const APP_LOAD = `load ./view/render
  find shout

load @term/site/view/render
  find show
`

const USE_SHOUT = `
task use-shout
  like text
  send back
    call shout
      text <hi>
`

const APP_LOAD_ONLY = `load ./view/render
  find shout
`

const caseF2 = APP_LOAD_ONLY + HEAD + FILE + VIEW + COPY + USE_SHOUT + boot('  call copy-it\n', '    call use-shout\n')
const caseF = APP_LOAD + HEAD + FILE + VIEW + COPY + USE_SHOUT + boot('  call copy-it\n', '    call use-shout\n')

const readRuntime = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)

const xcrun = spawnSync('xcrun', ['--version'], { encoding: 'utf8' })
const typechecks = !xcrun.error && xcrun.status === 0

if (!typechecks) {
  console.log('skip  swiftc typecheck  (xcrun is absent)')
}

type Built = { swift: string; file: string } | undefined

// compile for one Apple platform the way test/compile/shared/toolkit-run.ts does, write the Swift file, never run it
function build(name: string, text: string, leg: 'ios' | 'macos', where = HERE): Built {
  const entry = join(where, `${name}-${leg}.tree`)
  writeFileSync(entry, text)
  const result = compile({ file: entry, text }, { resolve: projectResolver(ROOT, leg), env: leg })
  ok(`${name} ${leg}: compiles`, result.ok, result.ok ? '' : result.diagnostics.slice(0, 4).map(d => d.message).join(' | '))

  if (!result.ok) {
    return undefined
  }

  const swift = emitSwift(result.program)
  const prelude = nativePrelude(result.program, leg, readRuntime, swift)
  // top-level code is allowed only in a file named main.swift
  const folder = join(HERE, `${name}-${leg}`)
  mkdirSync(folder)
  const file = join(folder, 'main.swift')
  // an async `main` (it reaches an async task) is awaited at the top level of main.swift
  const start = `${/func main\(\)[^{]*throws/.test(swift) ? 'try ' : ''}${/func main\(\)[^{]*async/.test(swift) ? 'await ' : ''}main()`
  writeFileSync(file, ['import Foundation', prelude, swift, start, ''].join('\n'))

  return { swift, file }
}

function typecheck(name: string, built: Built, leg: 'ios' | 'macos'): void {
  if (!built || !typechecks) {
    return
  }

  const args =
    leg === 'ios'
      ? ['-sdk', 'iphonesimulator', 'swiftc', '-typecheck', '-target', 'arm64-apple-ios17.0-simulator', '-module-name', SWIFT_MODULE, built.file]
      : ['swiftc', '-typecheck', '-module-name', SWIFT_MODULE, built.file]
  const run = spawnSync('xcrun', args, { encoding: 'utf8', timeout: 300_000 })
  const errors = `${run.stdout}\n${run.stderr}`.split('\n').filter(l => /error:/.test(l)).slice(0, 8).join('\n')
  ok(`${name} ${leg}: swiftc typechecks`, run.status === 0, errors || String(run.error ?? run.stderr).slice(0, 800))
}

// every call of a free function `append(`, not a method (`x.append(`) and not its definition
const calls = (swift: string, name: string): number => {
  const pattern = new RegExp(`(?<![.\\w])${name}\\(`, 'g')

  return [...swift.matchAll(pattern)].filter(m => !swift.slice(Math.max(0, m.index! - 5), m.index!).endsWith('func ')).length
}

const defines = (swift: string, name: string): boolean => new RegExp(`func ${name}\\(`).test(swift)

// the Swift spelling of a kebab name: `make-text__in0_0` is `makeText__in0_0`
const swiftName = (name: string): string => name.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())

// the body of the lowered `func screen(` up to the next top-level func
function bodyOf(swift: string, name: string): string {
  const at = swift.search(new RegExp(`(^|\\n)func ${name}\\(`))

  if (at < 0) {
    return ''
  }

  const next = swift.indexOf('\nfunc ', at + 2)

  return swift.slice(at, next < 0 ? undefined : next)
}

// the free calls of `<name>…(` in a body: not a method call
const freeCalls = (body: string, name: string): string[] => [...body.matchAll(new RegExp(`(?<![.\\w])(${name}\\w*)\\(`, 'g'))].map(m => m[1]!)

for (const leg of ['ios', 'macos'] as const) {
  // A: the defect
  const a = build('a', caseA, leg)
  typecheck('a', a, leg)

  if (a) {
    const renamed = [...a.swift.matchAll(/func (append__in0_\d+)\(/g)].map(m => m[1])
    ok(`a ${leg}: the build split append by file`, renamed.length >= 1, `renamed: ${renamed.join(', ')}`)
    ok(`a ${leg}: no call of a plain append whose definition is absent`, calls(a.swift, 'append') === 0 || defines(a.swift, 'append'), `calls ${calls(a.swift, 'append')}`)
    // the body of the lowered `screen` alone: render.tree's own `mount` calls a renamed append too
    const bound = runtimeBound.get('append') ?? ''
    const lowered = freeCalls(bodyOf(a.swift, 'screen'), 'append')
    ok(`a ${leg}: the lowered screen calls append, and only as the bound name`, /^append__in0_\d+$/.test(bound) && lowered.length > 0 && lowered.every(c => c === bound), `bound ${bound}, calls: ${lowered.join(', ')}`)
    ok(`a ${leg}: the bound append has the dom's labels`, a.swift.includes(`func ${bound}(parent:`), `bound ${bound}`)
  }

  // B: the entry defines the name
  const b = build('b', caseB, leg)
  typecheck('b', b, leg)

  if (b) {
    const mine = defines(b.swift, 'append')
    ok(`b ${leg}: the entry keeps its own append`, mine)
    // the body of the lowered `screen` alone: the entry's own call is folded by the inliner and render.tree's own calls
    // are not the lowering's
    const bound = runtimeBound.get('append') ?? ''
    const lowered = freeCalls(bodyOf(b.swift, 'screen'), 'append')
    ok(`b ${leg}: the lowered screen calls append, and only as the bound name`, /^append__in0_\d+$/.test(bound) && lowered.length > 0 && lowered.every(c => c === bound), `bound ${bound}, calls: ${lowered.join(', ')}`)
    ok(`b ${leg}: the lowered screen never calls the entry's append`, mine && !lowered.includes('append'), `calls: ${lowered.join(', ')}`)
  }

  // B2: the entry's append takes views, so a wrong binding compiles and only the text witness sees it
  const b2 = build('b2', caseB2, leg)
  typecheck('b2', b2, leg)

  if (b2) {
    const bound = runtimeBound.get('append') ?? ''
    const lowered = freeCalls(bodyOf(b2.swift, 'screen'), 'append')
    ok(`b2 ${leg}: the entry keeps its own append`, defines(b2.swift, 'append'))
    ok(`b2 ${leg}: the lowered screen calls append, and only as the bound name`, /^append__in0_\d+$/.test(bound) && lowered.length > 0 && lowered.every(c => c === bound), `bound ${bound}, calls: ${lowered.join(', ')}`)
    ok(`b2 ${leg}: the lowered screen never calls the entry's append`, !lowered.includes('append'), `calls: ${lowered.join(', ')}`)
  }

  // C: nothing split
  const c = build('c', caseC, leg)
  typecheck('c', c, leg)

  if (c) {
    ok(`c ${leg}: nothing was renamed`, !/append__in0_/.test(c.swift))
    const lowered = freeCalls(bodyOf(c.swift, 'screen'), 'append')
    ok(`c ${leg}: the lowered screen calls the dom's plain append`, defines(c.swift, 'append') && lowered.length > 0 && lowered.every(n => n === 'append'), `calls: ${lowered.join(', ')}`)
  }

  // E: the entry defines render.tree's own forwarders
  const e = build('e', caseE, leg)
  typecheck('e', e, leg)

  if (e) {
    // the body of the lowered `screen` alone: render.tree's own calls and the entry's are not the lowering's
    const screen = bodyOf(e.swift, 'screen')
    ok(`e ${leg}: the lowered screen is found`, screen.length > 0 && /\w\(/.test(screen))

    for (const name of ['make-text', 'write-attribute']) {
      const bound = runtimeBound.get(name) ?? ''
      const spelled = swiftName(bound)
      const plain = swiftName(name)
      ok(`e ${leg}: ${name} is split, render's is renamed`, new RegExp(`^${name}__in0_\\d+$`).test(bound), `bound ${bound}`)
      const lowered = [...screen.matchAll(new RegExp(`(?<![.\\w])(${plain}\\w*)\\(`, 'g'))].map(m => m[1])
      ok(`e ${leg}: the lowered screen calls ${name} and only as ${spelled}`, lowered.length > 0 && lowered.every(c => c === spelled), `calls: ${lowered.join(', ')}`)
      ok(`e ${leg}: ${spelled} has a func in the Swift`, defines(e.swift, spelled), `bound ${bound}`)
      ok(`e ${leg}: the entry keeps its own ${plain}`, defines(e.swift, plain))
    }
  }
}

// F: the app's own view/render.tree, in a fixed folder under the project root (rewritten each run)
const APP = join(ROOT, 'tmp', 'view-runtime-split-f')
mkdirSync(join(APP, 'view'), { recursive: true })
writeFileSync(join(APP, 'view', 'render.tree'), APP_RENDER)

for (const leg of ['ios', 'macos'] as const) {
  const f = build('f', caseF, leg, APP)
  typecheck('f', f, leg)

  if (f) {
    const bound = runtimeBound.get('append') ?? ''
    const lowered = freeCalls(bodyOf(f.swift, 'screen'), 'append')
    ok(`f ${leg}: append is bound to the dom's renamed append, not left plain`, /^append__in0_\d+$/.test(bound), `bound ${bound}`)
    ok(`f ${leg}: the lowered screen calls append, and only as the bound name`, lowered.length > 0 && lowered.every(c => c === bound), `bound ${bound}, calls: ${lowered.join(', ')}`)
    ok(`f ${leg}: the bound append has the dom's labels`, f.swift.includes(`func ${bound}(parent:`), `bound ${bound}`)
  }

  // F2: only the app's own ./view/render is loaded, so the runtime is given by the walk, not by a written load
  const f2 = build('f2', caseF2, leg, APP)
  typecheck('f2', f2, leg)

  if (f2) {
    const bound = runtimeBound.get('append') ?? ''
    const lowered = freeCalls(bodyOf(f2.swift, 'screen'), 'append')
    ok(`f2 ${leg}: append is bound to the dom's renamed append, not left plain`, /^append__in0_\d+$/.test(bound), `bound ${bound}`)
    ok(`f2 ${leg}: the lowered screen calls append, and only as the bound name`, lowered.length > 0 && lowered.every(c => c === bound), `bound ${bound}, calls: ${lowered.join(', ')}`)
  }
}

// D: the map, read after a merged build of case A
const mapped = build('d', caseA, 'ios')

if (mapped) {
  for (const name of ['append', 'remove', 'replace']) {
    const bound = runtimeBound.get(name) ?? ''
    // `remove` and `replace` are split only when @term/base/file defines them too, which it does
    ok(`d: ${name} is bound to the dom's renamed ${name}`, new RegExp(`^${name}__in0_\\d+$`).test(bound), `bound ${bound}`)
  }

  ok('d: make-element is bound to itself', runtimeBound.get('make-element') === 'make-element', `bound ${runtimeBound.get('make-element')}`)
}

console.log(`view-runtime-split: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
