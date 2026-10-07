// An implicit runtime is skipped by its resolved file, never by path text (beat-term-0064, decision D026).
// A module with a top-level `view` is given the render runtime (deck/site/code/view/render.tree) and a module with a web
// route the route runtime (view/route-runtime.tree) without a written load. compile/loading.tree `walk-one` leaves one
// out only when the module IS that file or a written load RESOLVES to it. An app's own `./view/render` is another file,
// so it gets the runtime too. Each case counts the runtime's file among the sources `collectModules` returns.
//
//   a  a view, no loads: the render runtime once
//   b  a view and the app's own ./view/render: the render runtime once, the app's file too
//   c  a view and a written `load @term/site/view/render`: once
//   d  a view and the legacy `load @cluesurf/site/code/view/render`: once
//   e  no view: absent
//   f  a web route and the app's own ./view/route-runtime: the route runtime once, the app's file too
//   g  deck/site/code/view/render.tree itself as the entry: once, no diagnostic
//
// A relative load must stay inside the project root (projectResolver), so every program is written under tmp/.
// Run: sh tmp/beat-tsx.sh test/compile/implicit-runtime.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectModules } from '@term/make/code/compile/load'
import { projectResolver } from '@term/call/code/make'

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

const ROOT = process.cwd()
const BASE = join(ROOT, 'tmp', 'implicit-runtime')
const RENDER = 'deck/site/code/view/render.tree'
const ROUTE = 'deck/site/code/view/route-runtime.tree'
const resolve = projectResolver(ROOT, 'node')

const VIEW = `
view screen
  take host, like view
  view span
    text <hello>
`

const ROUTE_TABLE = `
hook /
  view screen
`

// the app's own file of the same name as a runtime: it defines one unrelated task
const OWN = `
task shout
  take first, like text
  like text
  send back, text <{first}!>
`

const OWN_LOAD = `load ./view/render
  find shout
`

const OWN_ROUTE_LOAD = `load ./view/route-runtime
  find shout
`

// write one case's folder (rewritten each run) and walk its entry
function walk(name: string, entry: string, own: Record<string, string> = {}) {
  const folder = join(BASE, name)
  mkdirSync(join(folder, 'view'), { recursive: true })

  for (const [file, text] of Object.entries(own)) {
    writeFileSync(join(folder, file), text)
  }

  const file = join(folder, 'main.tree')
  writeFileSync(file, entry)

  return collectModules({ file, text: entry }, resolve)
}

const count = (sources: { file: string }[], ending: string): number => sources.filter(s => s.file.endsWith(ending)).length
const files = (sources: { file: string }[]): string => sources.map(s => s.file.replace(ROOT, '')).join(', ')

// a
const a = walk('a', VIEW)
ok('a: a view with no loads is given the render runtime once', count(a.sources, RENDER) === 1, files(a.sources))

// b
const b = walk('b', OWN_LOAD + VIEW, { 'view/render.tree': OWN })
ok('b: the app\'s own ./view/render still gets the render runtime, once', count(b.sources, RENDER) === 1, files(b.sources))
ok('b: the app\'s own file is walked too', count(b.sources, 'implicit-runtime/b/view/render.tree') === 1, files(b.sources))

// c
const c = walk('c', `load @term/site/view/render\n  find show\n${VIEW}`)
ok('c: a written load of the runtime by its package path gives it once', count(c.sources, RENDER) === 1, files(c.sources))

// d
const d = walk('d', `load @cluesurf/site/code/view/render\n  find show\n${VIEW}`)
ok('d: the legacy @cluesurf/site/code spelling gives it once', count(d.sources, RENDER) === 1, files(d.sources))

// e
const e = walk('e', OWN_LOAD, { 'view/render.tree': OWN })
ok('e: no view, no render runtime', count(e.sources, RENDER) === 0, files(e.sources))

// f
const f = walk('f', OWN_ROUTE_LOAD + VIEW + ROUTE_TABLE, { 'view/route-runtime.tree': OWN })
ok('f: the app\'s own ./view/route-runtime still gets the route runtime, once', count(f.sources, ROUTE) === 1, files(f.sources))
ok('f: the app\'s own file is walked too', count(f.sources, 'implicit-runtime/f/view/route-runtime.tree') === 1, files(f.sources))

// g
const renderFile = join(ROOT, RENDER)
const g = collectModules({ file: renderFile, text: readFileSync(renderFile, 'utf8') }, resolve)
ok('g: the runtime as the entry holds itself once', count(g.sources, RENDER) === 1, files(g.sources))
ok('g: and no diagnostic', g.diagnostics.length === 0, g.diagnostics.map(x => x.message).join(' | '))

console.log(`implicit-runtime: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
