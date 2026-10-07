// A relative `load` nothing answers is a build error naming the load and the reason (D027, beat-term-0065).
// projectResolver keeps a relative load inside the importer's package or the project root (the path-traversal guard)
// and answers not-found for anything else, and the compiler used to go on: the name the load would have given was
// bound to some other definition in silence (the dom's `append`, in the repro). Three cases:
//
//   a  the file is under the project root and exists: builds
//   b  the file is outside the project root (the system temp folder): refused, naming `load ./extra`
//   c  the file is under the project root and missing: refused, naming `load ./gone`
//   d  a path with a {platform} slot and no such file: not refused at the load
//
// Run: sh tmp/beat-tsx.sh test/compile/unresolved-relative-load.ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info.slice(-800)}`)
  }
}

const ROOT = process.cwd()

const EXTRA = `
task shout
  take first, like text
  like text
  send back, text <{first}!>
`

const entry = (path: string): string => `load ${path}
  find shout

task main
  like text
  send back
    call shout
      text <hi>
`

function attempt(folder: string, load: string, files: Record<string, string>) {
  mkdirSync(folder, { recursive: true })

  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(folder, name), text)
  }

  const text = entry(load)

  return compile({ file: join(folder, 'main.tree'), text }, { resolve: projectResolver(ROOT, 'node'), env: 'node' })
}

const inside = join(ROOT, 'tmp', 'unresolved-relative-load')
const outside = mkdtempSync(join(tmpdir(), 'term-unresolved-relative-load-'))

const a = attempt(join(inside, 'present'), './extra', { 'extra.tree': EXTRA })
ok('a: a relative load of a file under the root builds', a.ok, a.ok ? '' : a.diagnostics.map(d => d.message).join(' | '))

const b = attempt(join(outside, 'present'), './extra', { 'extra.tree': EXTRA })
const bMessages = b.ok ? [] : b.diagnostics.map(d => d.message)
ok('b: a relative load of a file outside the root is refused', !b.ok)
ok('b: the refusal names the load and the roots', bMessages.some(m => m.includes('load ./extra') && m.includes('project roots')), bMessages.join(' | '))

const c = attempt(join(inside, 'absent'), './gone', {})
const cMessages = c.ok ? [] : c.diagnostics.map(d => d.message)
ok('c: a relative load of a missing file is refused', !c.ok)
ok('c: the refusal names the load', cMessages.some(m => m.includes('load ./gone')), cMessages.join(' | '))

// d: a `{platform}` slot is the one relative load left to the build on each platform (D027)
const d = attempt(join(inside, 'slot'), './native/{platform}/gone', {})
const dMessages = d.ok ? [] : d.diagnostics.map(m => m.message)
ok('d: a {platform} relative load with no such file is not refused at the load', !dMessages.some(m => m.includes('nothing answers')), dMessages.join(' | '))

console.log(`unresolved-relative-load: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
