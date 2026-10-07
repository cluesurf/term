// The view lowering's runtime calls bind as render.tree binds them (beat-term-0043, decision D020). A merged native
// build splits a task two files define by file (`append`, defined by @term/base/file and by the toolkit dom, becomes
// `append__in0_<k>`), and the lowering ran after that and still wrote the plain `append`: swiftc said
// `cannot find 'append' in scope`. Four cases, none of which RUNS an app or touches a simulator: the Swift is only
// typechecked, for the iPhone simulator SDK and for macOS.
//
//   A  the defect: a view and @term/base/file in one program
//   B  the entry file defines a task `append` of its own: it keeps its name, the lowering calls the dom's
//   C  nothing is split: no @term/base/file, the lowering calls the dom's plain `append`
//   D  the map: disambiguateOverloads leaves runtimeBound naming append, remove and replace by the dom's renamed
//      names and make-element by itself
//
// Run: sh tmp/beat-tsx.sh test/compile/view-runtime-split.ts
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
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
  save kept
    call append
      text <a>
      text <b>
`

const BOOT = `
task boot
  call mount-app
    task route
      take host, like view
      take path, like text
      call screen
        read host
    text <Repro>
  call run-app
`

const caseA = HEAD + FILE + VIEW + COPY + BOOT
const caseB = HEAD + FILE + VIEW + COPY + OWN + BOOT
const caseC = HEAD + VIEW + BOOT

const readRuntime = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)

const xcrun = spawnSync('xcrun', ['--version'], { encoding: 'utf8' })
const typechecks = !xcrun.error && xcrun.status === 0

if (!typechecks) {
  console.log('skip  swiftc typecheck  (xcrun is absent)')
}

type Built = { swift: string; file: string } | undefined

// compile for one Apple platform the way test/compile/shared/toolkit-run.ts does, write the Swift file, never run it
function build(name: string, text: string, leg: 'ios' | 'macos'): Built {
  const entry = join(HERE, `${name}-${leg}.tree`)
  writeFileSync(entry, text)
  const result = compile({ file: entry, text }, { resolve: projectResolver(ROOT, leg), env: leg })
  ok(`${name} ${leg}: compiles`, result.ok, result.ok ? '' : result.diagnostics.slice(0, 4).map(d => d.message).join(' | '))

  if (!result.ok) {
    return undefined
  }

  const swift = emitSwift(result.program)
  const prelude = nativePrelude(result.program, leg, readRuntime, swift)
  const file = join(HERE, `${name}-${leg}.swift`)
  const start = /func main\(\)[^{]*throws/.test(swift) ? 'try main()' : 'main()'
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

for (const leg of ['ios', 'macos'] as const) {
  // A: the defect
  const a = build('a', caseA, leg)
  typecheck('a', a, leg)

  if (a) {
    const renamed = [...a.swift.matchAll(/func (append__in0_\d+)\(/g)].map(m => m[1])
    ok(`a ${leg}: the build split append by file`, renamed.length >= 2, `renamed: ${renamed.join(', ')}`)
    ok(`a ${leg}: no call of a plain append whose definition is absent`, calls(a.swift, 'append') === 0 || defines(a.swift, 'append'), `calls ${calls(a.swift, 'append')}`)
    ok(`a ${leg}: the lowered view calls a renamed append`, renamed.some(name => calls(a.swift, name) > 0), `renamed: ${renamed.join(', ')}`)
  }

  // B: the entry defines the name
  const b = build('b', caseB, leg)
  typecheck('b', b, leg)

  if (b) {
    const mine = defines(b.swift, 'append')
    ok(`b ${leg}: the entry keeps its own append`, mine)
    ok(`b ${leg}: the entry's append is called once, by the entry`, calls(b.swift, 'append') === 1, `calls ${calls(b.swift, 'append')}`)
    const bound = runtimeBound.get('append') ?? ''
    ok(`b ${leg}: the lowered view calls the dom's renamed append`, /^append__in0_\d+$/.test(bound) && calls(b.swift, bound) > 0, `bound ${bound}`)
  }

  // C: nothing split
  const c = build('c', caseC, leg)
  typecheck('c', c, leg)

  if (c) {
    ok(`c ${leg}: nothing was renamed`, !/append__in0_/.test(c.swift))
    ok(`c ${leg}: the lowered view calls the dom's plain append`, defines(c.swift, 'append') && calls(c.swift, 'append') > 0)
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
