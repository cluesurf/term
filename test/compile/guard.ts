// Guards: `note unsafe` over a body with a `halt take` handler lowers to try / catch, the caught value is bound, and
// a raise inside the body reaches the handler at run time. Run: npx tsx test/compile/guard.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'

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

const STDLIB = `form exception
  head p
  link host, like text
  link form, like text
  link note, like text
  link code, like text
  link time, like number
  link link, like p

task exception-code
  like text
  send back, text <kvmtnhbs-rzdxfwlc-mnbdtkhs-fvzxcwlr>

task exception-time
  like number
  send back, code 7

form absence
  like exception
    bind note, <Not found>
    link thing, like text
`

const SOURCE = `${STDLIB}
task find-it
  take key, like text
  like number
  fork test
    hook test
      call is-equal
        read key
        text <a>
    hook hold
      send back, code 1
    hook miss
      halt absence
        bind thing, read key

task lookup
  take key, like text
  like text
  note unsafe
    save found
      call find-it
        read key
    send back
      text <found>
  halt take
    take problem
    send back
      read problem/note
`

async function main(): Promise<void> {
  const result = compile({ file: 'g.tree', text: SOURCE })
  ok(
    'a guarded body with a handler compiles',
    result.ok,
    result.ok ? '' : result.diagnostics.map(d => d.message ?? d.name).join(' | '),
  )

  const ts = result.ok ? result.typescript : ''
  ok('it lowers to try', ts.includes('try {'))
  ok('the handler binds the caught value', ts.includes('catch (problem)'))
  ok('the handler reads the caught note', ts.includes('problem.note'))

  if (result.ok) {
    const dir = mkdtempSync(join(tmpdir(), 'term-guard-'))
    const file = join(dir, 'g.mjs')
    writeFileSync(
      file,
      transformSync(result.typescript, { loader: 'ts', format: 'esm' }).code,
    )
    const mod = await import(pathToFileURL(file).href)
    ok('the happy path returns', mod.lookup('a') === 'found')
    ok('the raise reaches the handler', mod.lookup('b') === 'Not found')
  }

  // a fork case over the caught value: the form is the discriminant, the arm binds the form's props by name
  const CASED = `${STDLIB}
form user-absence
  like absence
    bind note, <No such user>
    link key, like text

task find-user
  take key, like text
  like text
  halt user-absence
    bind thing, text <user>
    bind key, read key

task describe
  take key, like text
  like text
  note unsafe
    send back
      call find-user
        read key
  halt take
    take problem
    fork case, read problem
      case user-absence
        send back, text <no user {{key}}: {{note}}>
`
  const cased = compile({ file: 'c.tree', text: CASED })
  ok('a fork case over the caught exception compiles', cased.ok, cased.ok ? '' : cased.diagnostics.map(d => d.message).join(' | '))

  if (cased.ok) {
    const dir = mkdtempSync(join(tmpdir(), 'term-guard-case-'))
    const file = join(dir, 'c.mjs')
    writeFileSync(file, transformSync(cased.typescript, { loader: 'ts', format: 'esm' }).code)
    const mod = await import(pathToFileURL(file).href)
    ok('the arm binds the form\'s prop and the shared note', mod.describe('zed') === 'no user zed: No such user', String(mod.describe('zed')))
  }

  const UNCOVERED = CASED.replace('    link key, like text\n', '    link key, like text\n\nform user-denial\n  like absence\n    bind note, <Not yours>\n').replace('  halt user-absence\n    bind thing, text <user>\n    bind key, read key\n', '  fork test\n    hook test\n      call is-equal\n        read key\n        text <x>\n    hook hold\n      halt user-denial\n        bind thing, text <user>\n  halt user-absence\n    bind thing, text <user>\n    bind key, read key\n')
  const uncovered = compile({ file: 'u.tree', text: UNCOVERED })
  ok(
    'a fork case that misses a form the body can raise is refused',
    !uncovered.ok && uncovered.diagnostics.some(d => d.message.includes('can also raise user-denial')),
    uncovered.ok ? 'compiled' : uncovered.diagnostics.map(d => d.message).join(' | '),
  )

  const ORPHAN = `${STDLIB}
task orphan
  halt take
    take problem
    send back, code 1
`
  const orphan = compile({ file: 'g.tree', text: ORPHAN })
  ok(
    'a halt take without a guard is refused',
    !orphan.ok &&
      orphan.diagnostics.some(d => (d.message ?? '').includes('must follow')),
  )

  console.log(`\nguard: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }
}

main()
