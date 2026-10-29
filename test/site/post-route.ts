// One route for a page and its actions (term-site-framework-0006, decision 001 of note/project/term/site-framework):
// a `hook` route draws its `view` on GET and answers any other method with its `task <method>`, a handler
// `(request, params) -> response`, through the dispatcher `route(host, request)` (compile/route-lower.tree). A method
// the route has no task for answers 405, and a handler of the wrong shape is refused at build (check/routes.tree).
//
// The app is compiled against the real stdlib, @term/host and @term/site with the node host, bundled with its runtime
// shims as `term boot` would, started on a port, and spoken to over HTTP: a urlencoded POST read by
// @term/site/http/body and answered with a 303, the page still drawn on GET with the note its typed `load` (a list of
// texts) now lists, escaped, PUT refused with 405 and the methods the
// route serves in `allow`, and a DELETE whose handler reads its `:id` from `params`.
// Run: npx tsx test/site/post-route.ts

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
import { nativePrelude } from '@term/make/code/compile/native'

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

const TERM = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)
const PORT = 38563

const HEAD = `load @term/site/code/http/http
  find request
  find response

load @term/site/code/http/body
  find read-body
  find redirect

load @term/face/code/component/text
  find text

form note-input
  link title, like text

view notes-page
  take host, like view
  take notes, like list, like text
  view span
    text <the notes page>
  view div
    walk list, read notes
      hook next
        take site, name item
        view text
          bind content, read item
`

const APP = `${HEAD}
load @term/base/list
  find list
  find push

# the notes made so far, held in the process
host made
  like list, like text
  make list

# the page's data: a typed list, which the route's load hands the view
task load-notes
  take path, like text
  like list, like text
  send back, read made

# GET draws the list; POST reads the form, keeps the note, and answers 303 to the list
hook /notes
  seed load, read load-notes
  view notes-page
    bind notes, read data
  task post
    take request
    take params
    save note
      call fill
        call read-body(read request)
        like note-input
    call push
      read made
      read note/title
    send back
      call redirect
        text </notes?made={note/title}>

# DELETE reads its :id from params
hook /notes/:id
  take path
    take id
      like text
  seed load, read load-notes
  view notes-page
    bind notes, read data
  task delete
    take request
    take params
    save id
      call params/get
        text <id>
    send back
      call redirect
        text </notes?gone={id}>
`

// a handler with one parameter, and one answering text: each refused at build, naming what a handler is
const ONE_PARAMETER = `${HEAD}
hook /notes
  view notes-page
  task post
    take request
    send back
      call redirect
        text </notes>
`

const WRONG_ANSWER = `${HEAD}
hook /notes
  view notes-page
  task post
    take request
    take params
    like text
    send back, text <done>
`

// `task get` would never run: GET draws the view
const GET_TASK = `${HEAD}
hook /notes
  view notes-page
  task get
    take request
    take params
    send back
      call redirect
        text </notes>
`

const resolve = projectResolver(TERM, 'node')

function build1(
  name: string,
  text: string,
): ReturnType<typeof compile> {
  const entry = path.join(
    TERM,
    'test',
    'tmp',
    `post-route-${name}.tree`,
  )
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  fs.writeFileSync(entry, text)

  return compile({ file: entry, text }, { resolve, env: 'node' })
}

const messages = (result: ReturnType<typeof compile>): string =>
  result.ok
    ? ''
    : [
        ...new Set(
          result.diagnostics.map(
            d =>
              `${d.file?.split('/').pop()}:${d.span?.start?.line}: ${d.message}`,
          ),
        ),
      ]
        .slice(0, 6)
        .join(' | ')

async function main(): Promise<void> {
  // the wrong shapes first: they need no server
  for (const [name, text, why] of [
    ['one-parameter', ONE_PARAMETER, 'it takes 1 parameters'],
    [
      'wrong-answer',
      WRONG_ANSWER,
      'it answers something other than a `response`',
    ],
  ] as const) {
    const refused = build1(name, text)
    const said = messages(refused)
    ok(
      `a handler where ${why} is refused at build`,
      !refused.ok &&
        said.includes('is not a handler') &&
        said.includes(why),
      said || 'it compiled',
    )
  }

  const getTask = build1('get-task', GET_TASK)
  const getSaid = messages(getTask)
  ok(
    '`task get` under a page route is refused: GET draws the view',
    !getTask.ok && getSaid.includes('GET and HEAD draw the route'),
    getSaid || 'it compiled',
  )

  const result = build1('app', APP)
  ok(
    'the app with a page route and its methods compiles',
    result.ok,
    messages(result),
  )

  if (!result.ok) {
    console.log(`\npost-route: ${pass} pass, ${fail} fail`)
    process.exit(1)
  }

  ok(
    'the dispatcher takes the request',
    /function route\(host: View, request: Request\)/.test(
      result.typescript,
    ),
    result.typescript.match(/function route\([^)]*\)/)?.[0] ??
      'no route',
  )

  const readRuntime = (p: string): string | undefined =>
    fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined
  const prelude = nativePrelude(
    result.program,
    'node',
    readRuntime,
    result.typescript,
  )
  const dir = fs.mkdtempSync(
    path.join(TERM, 'test', 'tmp', 'post-route-'),
  )
  fs.writeFileSync(
    path.join(dir, 'app.ts'),
    `${prelude}\n${result.typescript}`,
  )

  const bundled = await build({
    entryPoints: [path.join(dir, 'app.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['hono', '@hono/node-server'],
    write: false,
  })
  const file = path.join(dir, 'app.mjs')
  fs.writeFileSync(file, bundled.outputFiles[0].text)

  const M = (await import(pathToFileURL(file).href)) as {
    boot: (url: string, port: number) => unknown
    wakeHive?: () => void
  }
  M.wakeHive?.()
  await M.boot('', PORT)
  await new Promise(r => setTimeout(r, 300))

  const at = (p: string, init: RequestInit = {}) =>
    fetch(`http://localhost:${PORT}${p}`, {
      redirect: 'manual',
      ...init,
    })

  const page = await at('/notes')
  const pageBody = await page.text()
  ok(
    'GET /notes draws the page',
    page.status === 200 && pageBody.includes('the notes page'),
    `${page.status} ${pageBody.slice(0, 200)}`,
  )

  const title = 'a "first" & <b>note</b>'
  const posted = await at('/notes', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `title=${encodeURIComponent(title).replace(/%20/g, '+')}`,
  })
  ok(
    'POST /notes with a urlencoded form answers 303',
    posted.status === 303,
    `${posted.status} ${await posted.text()}`,
  )
  ok(
    'the 303 goes to the list, carrying the title the form body held',
    posted.headers.get('location') === `/notes?made=${title}`,
    String(posted.headers.get('location')),
  )

  const listed = await at('/notes')
  const listedBody = await listed.text()
  ok(
    'GET /notes after the post draws the note the load listed, its markup escaped',
    listed.status === 200 &&
      listedBody.includes('&lt;b&gt;note&lt;/b&gt;') &&
      !listedBody.includes('<b>note</b>'),
    listedBody.slice(0, 400),
  )

  const put = await at('/notes', { method: 'PUT', body: '' })
  ok(
    'PUT /notes, which no task serves, answers 405',
    put.status === 405,
    String(put.status),
  )
  ok(
    'the 405 names the methods the route serves',
    put.headers.get('allow') === 'GET, HEAD, POST',
    String(put.headers.get('allow')),
  )

  const gone = await at('/notes/7', { method: 'DELETE' })
  ok(
    "DELETE /notes/7 calls the route's task with its :id in params",
    gone.status === 303 &&
      gone.headers.get('location') === '/notes?gone=7',
    `${gone.status} ${gone.headers.get('location')}`,
  )

  const postOnId = await at('/notes/7', { method: 'POST', body: '' })
  ok(
    'POST /notes/7, which only serves DELETE, answers 405',
    postOnId.status === 405 &&
      postOnId.headers.get('allow') === 'GET, HEAD, DELETE',
    `${postOnId.status} ${postOnId.headers.get('allow')}`,
  )

  const missing = await at('/nowhere')
  ok(
    'GET of a path no hook names still answers 404',
    missing.status === 404,
    String(missing.status),
  )

  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`\npost-route: ${pass} pass, ${fail} fail`)
  process.exit(fail > 0 ? 1 : 0)
}

main()
