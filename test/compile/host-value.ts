// A host value is checked where the program gives it a type. A call into a `dock load` module returns the host's
// own value, which the checker cannot see into, so until 2026-10-05 `save count / like number / path/join(...)`
// compiled on TypeScript and `count` held a text all the way to whatever used it. Now the binding checks the value
// it is given (`__termHost` in compile/typescript.ts) and raises `data-mismatch` there, where the type was written.
// The native backends type a host call statically, so the compiler of each refuses the same program instead.
// A field read off an opaque `dock type` handle is refused at the checker (check/infer.ts).
// Run: npx tsx test/compile/host-value.ts

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOn } from './shared/run-on'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'

const ROOT = join(import.meta.dirname, '..', '..')

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

const dir = mkdtempSync(join(tmpdir(), 'host-value-'))
const program = `dock load
  load <node:path>, name path

task run
  like text
  save joined
    like text
    path/join(<code>, <boot.tree>)
  save answer, <none>
  mark unsafe
    save count
      like number
      path/join(<a>, <b>)
    save answer, <{count}>
  halt take
    take problem
    save answer, <{problem/form}: {problem/link/reason}>
  back <{joined} {answer}>
`
const ran = runOn({ backend: 'typescript', program, resolve: env => projectResolver(ROOT, env, ROOT), dir, name: 'host' })
const output = ran.form === 'ran' ? ran.output : `${ran.form}: ${ran.reason.slice(0, 400)}`

ok('a host value of the declared type passes through', output.startsWith('code/boot.tree '), output)
ok('a host value of another type raises data-mismatch at the binding', output.endsWith('data-mismatch: is a text where a number belongs'), output)

const emitted = readFileSync(join(dir, 'host-typescript.ts'), 'utf8')
ok('the check is written on the binding', emitted.includes('__termHost(path.join("a", "b"), "number", "count")'), emitted.slice(0, 400))

const plain = `dock load
  load <node:path>, name path

task run
  like text
  save joined, path/join(<code>, <boot.tree>)
  back joined
`
const loose = mkdtempSync(join(tmpdir(), 'host-value-'))
runOn({ backend: 'typescript', program: plain, resolve: env => projectResolver(ROOT, env, ROOT), dir: loose, name: 'host' })
const untyped = readFileSync(join(loose, 'host-typescript.ts'), 'utf8')
ok('a host value given no type is left alone', !untyped.includes('__termHost('), untyped.slice(0, 400))

const handle = `dock type
  load <any>, name url-handle

bind parse-url, take href, like text
  like url-handle
  case node
    <new URL($href)>
  case browser
    <new URL($href)>
  case rust
    <std::rc::Rc::new(url::Url::parse(&$href).unwrap()) as std::rc::Rc<dyn std::any::Any>>
  case swift
    load <Foundation>
    <URLComponents(string: $href)!>
  case kotlin
    <java.net.URI($href)>

task run
  like text
  save url, parse-url(<https://term.surf/guides>)
  back url/host
`
const read = compile({ file: join(ROOT, 'tmp/host-handle.tree'), text: handle }, { resolve: projectResolver(ROOT, 'node', ROOT) })
const refused = read.ok ? 'BUILT' : read.diagnostics.map(d => d.message).join(' | ')
ok('a field read off an opaque handle is refused', /"host" is read off a `url-handle`/.test(refused), refused)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
