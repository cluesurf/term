// A trailing `need false` parameter with no `fall` is its type's empty value in the body, on every backend
// (term-self-host-001-0398, decision 074 of note/project/term/self-host/change/001-finish-self-host). Until 2026-10-29
// the TypeScript emitter wrote it `p?: T`, so tsc typed a read of it `T | undefined` and refused handing it on to a
// task that requires a `T` (TS2345, process/run.tree `run` passing `environment` to `spawn-process`). It now writes
// `p: T = <empty>` wherever the type has an empty value, and keeps `p?: T` where it has none (a `maybe`), since
// `undefined` is a maybe's none on TypeScript.
// Run: npx tsx test/compile/need-false-param.ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { projectResolver } from '@term/call/code/make'
import { compile } from '@term/make/code/compile/compile'
import { runOn } from './shared/run-on'

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

const PROGRAM = `load @term/base/list
  find list

load @term/base/maybe
  find maybe

task count-table
  take table
    like hash
      like text
      like number
  like number
  save n, 0
  walk table/keys()
    take k
    save n, add(n, table/get(k))
  back n

task count-items
  take items
    like list
      like text
  like number
  back items/length

task text-size
  take label, like text
  like number
  back label/length

task with-table
  take base, like number
  take table
    like hash
      like text
      like number
    need false
  like number
  back add(base, count-table(table))

task with-items
  take base, like number
  take items
    like list
      like text
    need false
  like number
  back add(base, count-items(items))

task with-label
  take base, like number
  take label
    like text
    need false
  like number
  back add(base, text-size(label))

task run
  like text
  save table, make hash
  table/set(<a>, 2)
  send back, <{with-table(1)} {with-table(1, table)} {with-items(1)} {with-items(1, make(list, <x>, <y>))} {with-label(1)} {with-label(1, <abc>)}>
`

// A maybe has no empty value on TypeScript, so its parameter keeps `?`. Only its signature is held here: a left-out
// maybe parameter reaches the body as undefined and its sift reads `.form` off it, a defect of its own (logged by
// term-self-host-001-0398, filed as its own item), not this one's.
const MAYBE_PROGRAM = `load @term/base/maybe
  find maybe

task with-maybe
  take base, like number
  take extra
    like maybe
      like number
    need false
  like number
  sift extra
    case some
      link given
      back add(base, given)
    case none
      back base
`

const dir = mkdtempSync(join(tmpdir(), 'term-need-false-param-'))
const built = compile({ file: join(dir, 'params.tree'), text: PROGRAM }, { resolve: projectResolver(process.cwd(), 'node'), env: 'node' })

if (!built.ok) {
  ok('the program builds', false, built.diagnostics.map(d => JSON.stringify(d).slice(0, 600)).join(' | '))
} else {
  const emitted = built.typescript
  const signature = (name: string): string => emitted.match(new RegExp(`function ${name}\\(([^)]*)\\)`))?.[1] ?? `(no ${name})`

  ok('a need-false hash is written with its empty value', /table: Map<string, number> = new Map\(\)/.test(signature('withTable')), signature('withTable'))
  ok('a need-false list is written with its empty value', /items: (Array<string>|string\[\]) = \[\]/.test(signature('withItems')), signature('withItems'))
  ok('a need-false text is written with its empty value', /label: string = ""/.test(signature('withLabel')), signature('withLabel'))

  // tsc --strict over the emitted module: no read of a need-false parameter is `T | undefined`
  const file = join(dir, 'params.ts')
  const options: ts.CompilerOptions = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, skipLibCheck: true, lib: ['lib.es2022.d.ts'] }
  const host = ts.createCompilerHost(options)
  const readFile = host.readFile
  host.readFile = (name: string) => (name === file ? emitted : readFile.call(host, name))
  const exists = host.fileExists
  host.fileExists = (name: string) => name === file || exists.call(host, name)
  const getSource = host.getSourceFile
  host.getSourceFile = (name, version, onError, create) =>
    name === file ? ts.createSourceFile(name, emitted, version, true, ts.ScriptKind.TS) : getSource.call(host, name, version, onError, create)
  const program = ts.createProgram([file], options, host)
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(d => d.file?.fileName === file)
  const undefinedArgument = diagnostics.filter(d => d.code === 2345 || d.code === 18048 || d.code === 2322)
  ok(
    'tsc --strict refuses no read of a need-false parameter',
    undefinedArgument.length === 0,
    undefinedArgument.map(d => `TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`).join(' | '),
  )
}

{
  const maybe = compile({ file: join(dir, 'maybe.tree'), text: MAYBE_PROGRAM }, { resolve: projectResolver(process.cwd(), 'node'), env: 'node', library: true } as never)
  const signature = maybe.ok ? (maybe.typescript.match(/function withMaybe\(([^)]*)\)/)?.[1] ?? '(no withMaybe)') : maybe.diagnostics.map(d => d.message).join(' | ')
  ok('a need-false maybe keeps `?`, having no empty value', /extra\?: /.test(signature) && !signature.includes('='), signature)
}

const ran = runOn({ backend: 'typescript', program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'params' })

if (ran.form === 'skipped') {
  console.log(`skip  typescript: ${ran.reason}`)
} else {
  ok(
    'typescript: each parameter runs left out and given',
    ran.form === 'ran' && ran.output === '1 3 1 3 1 4',
    ran.form === 'ran' ? `got ${JSON.stringify(ran.output)}` : `${ran.stage}: ${ran.reason}`,
  )
}

console.log(`\nneed-false-param: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
