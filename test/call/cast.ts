// `term cast` refuses an entry whose `boot` returns nothing (guides: commands/cast, 2026-10-04). The Worker's default
// export is what `boot` returns, so such a cast wrote a Worker with no `fetch`, with the same `✓` items and verdict as
// a good one, and the first request was where it showed. The good cast's Worker still answers a request.
//
// Run: npx tsx test/call/cast.ts (after `pnpm run make:line`)

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const LINE = process.env.TERM_LINE ?? join(HERE, '../../host/line.js')

let pass = 0
let fail = 0

function ok(name: string, good: boolean, detail = ''): void {
  if (good) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `  ${detail}` : ''}`)
  }
}

// the page application on commands/cast, with the last line of `boot` as given
function project(last: string): string {
  const root = mkdtempSync(join(tmpdir(), 'term-cast-'))
  mkdirSync(join(root, 'code'))
  writeFileSync(join(root, 'deck.tree'), 'deck shop\n  mark <0.0.1>\n  boot ./code/boot\n')
  writeFileSync(
    join(root, 'code/boot.tree'),
    [
      'load @term/site/dom/dom',
      '  find view',
      '',
      'load @term/site/view/native/{platform}/host',
      '  find host',
      '',
      'view home',
      '  take host, like view',
      '  view h1, <Home>',
      '',
      'task route',
      '  take host, like view',
      '  take path, like text',
      '',
      '  home host',
      '',
      'task boot',
      '  take url, like text',
      '  take port, like u16',
      '',
      `  ${last}`,
      '',
    ].join('\n'),
  )

  return root
}

function cast(root: string): { status: number | null; said: string } {
  const run = spawnSync('node', [LINE, 'cast'], { cwd: root, encoding: 'utf8', timeout: 240_000, env: { ...process.env, NO_COLOR: '1' } })

  return { status: run.status, said: `${run.stdout}${run.stderr}` }
}

// ---- a boot that returns nothing ----
{
  const root = project('host(route, port)')
  const { status, said } = cast(root)
  ok('a `boot` that returns nothing is refused, exit 1', status === 1 && /`boot` returns no fetch handler, so the Worker would have none/.test(said), `${status} ${said}`)
  ok('the refusal says how to return the handler', /back host\(route, port\)/.test(said), said)
  ok('and nothing is written', !existsSync(join(root, 'work/index.ts')))
}

// ---- a boot that returns a value that is not a handler ----
{
  const root = project('back port')
  const { status, said } = cast(root)
  ok('a `boot` that returns a number is refused the same way, exit 1', status === 1 && /`boot` returns no fetch handler/.test(said), `${status} ${said}`)
}

// ---- a boot that hands the handler back ----
{
  const root = project('back host(route, port)')
  const { status, said } = cast(root)
  ok('`back host(route, port)` casts, exit 0', status === 0 && /Cast to a Cloudflare Worker/.test(said), `${status} ${said}`)

  const app = join(root, 'work/app.mjs')

  if (existsSync(app)) {
    const module = (await import(pathToFileURL(app).href)) as { boot: (url: string, port: number) => Promise<{ fetch?: (r: Request) => Promise<Response> }> }
    const worker = await module.boot('', 0)
    ok('its Worker exports `fetch`', typeof worker?.fetch === 'function', String(Object.keys(worker ?? {})))

    if (typeof worker?.fetch === 'function') {
      const response = await worker.fetch(new Request('http://worker.test/'))
      const html = await response.text()
      ok('and answers a request with the page', response.status === 200 && /text\/html/.test(response.headers.get('content-type') ?? ''), `${response.status}`)
      // `home host` alone in `route` was dropped by the mill (`home` is a word of the binding dialect), so the body
      // was an empty `<div></div>` (guides: commands/cast, applications/web, 2026-10-04)
      ok('whose body holds the component `route` placed', /<h1>Home<\/h1>/.test(html), /<body>[\s\S]*<\/body>/.exec(html)?.[0])
      // the Worker is a production build whatever its `process.env` says: no reload poller, no empty `?v=`
      ok('and carries no development reload script or empty `?v=`, with NODE_ENV unset', process.env.NODE_ENV === undefined && !html.includes('/base/__id') && !/\?v="/.test(html), `${process.env.NODE_ENV} ${(/<head>[\s\S]*<\/head>/.exec(html) ?? [''])[0]}`)
      // the client bundle is named by its content, from the manifest baked into the bundle, and that file is there.
      // This project has no stylesheet, so `look.css` has nothing to hash
      const script = /src="\/base\/(boot-[a-z]{4}-[a-z]{4}\.js)"/.exec(html)?.[1]
      ok('its client bundle link names a content-hashed file under build/', script !== undefined && existsSync(join(root, 'build', script)), (/<head>[\s\S]*<\/head>/.exec(html) ?? [''])[0])
    }

    const bundled = readFileSync(app, 'utf8')
    ok('and work/app.mjs is minified', bundled.split('\n').length < 40 && !bundled.includes('// '), `${bundled.split('\n').length} lines`)
  } else {
    ok('its Worker exports `fetch`', false, 'no work/app.mjs')
  }
}

console.log(`\ncast: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
