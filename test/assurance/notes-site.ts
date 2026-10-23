// The notes demo as a web app (term-assurance-demo-0002, note/project/term/assurance/mvp.md): notes/code/site.tree
// serves the model's `step`, `replay` and `view` and permit.tree's `grant-delete` on page routes with methods
// (decision 001 of note/project/term/site-framework).
//
// 1. `term cast` builds it for Cloudflare, in a copy of the package (cast writes work/ and build/ beside deck.tree),
//    and the Worker it writes answers a GET, a POST and a refusal in process.
// 2. The same source is compiled for the node host against the real stdlib, @term/site and @term/face, bundled with
//    its runtime shims as test/site/post-route.ts does, started on a port, and spoken to over real HTTP: create, list,
//    show, edit and delete; a hostile title comes back escaped; a change without a permit is refused (403), one from
//    nobody 401; another person's note is not shown; a body of the wrong type answers 415 and one that does not fit the
//    form 400.
//
// The person is the header `x-person` (and `x-rank: admin`): the demo has no sign-in (site.tree says so).
// Run: npx tsx test/assurance/notes-site.ts

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import { projectDeckOf } from '@term/call/code/deck-of'
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

const TERM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const NOTES = path.join(TERM, 'test', 'assurance', 'notes')
const SITE = path.join(NOTES, 'code', 'site.tree')
const LINE = process.env.TERM_LINE ?? path.join(TERM, 'host', 'line.js')
const PORT = 38571

const OWNER = { 'x-person': '3' }
const OTHER = { 'x-person': '4' }
const ADMIN = { 'x-person': '9', 'x-rank': 'admin' }
const FORM = { 'content-type': 'application/x-www-form-urlencoded' }

const formBody = (title: string): string => `title=${encodeURIComponent(title).replace(/%20/g, '+')}`

function finish(): never {
  console.log(`\nnotes-site: ${pass} pass, ${fail} fail`)
  process.exit(fail > 0 ? 1 : 0)
}

// ---- 1. term cast, Cloudflare ----

async function cast(): Promise<void> {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'notes-cast-'))
  fs.mkdirSync(path.join(root, 'code'))
  for (const name of ['deck.tree', 'role.tree']) fs.copyFileSync(path.join(NOTES, name), path.join(root, name))
  for (const name of fs.readdirSync(path.join(NOTES, 'code'))) {
    if (name.endsWith('.tree')) fs.copyFileSync(path.join(NOTES, 'code', name), path.join(root, 'code', name))
  }

  const run = spawnSync('node', [LINE, 'cast'], { cwd: root, encoding: 'utf8', timeout: 400_000, env: { ...process.env, NO_COLOR: '1' } })
  const said = `${run.stdout}${run.stderr}`
  ok('`term cast` builds the notes site for a Cloudflare Worker, exit 0', run.status === 0 && /Cast to a Cloudflare Worker/.test(said), `${run.status} ${said.slice(-1500)}`)

  const app = path.join(root, 'work', 'app.mjs')
  if (!fs.existsSync(app)) {
    ok('the cast wrote work/app.mjs', false)
    return
  }

  const M = (await import(pathToFileURL(app).href)) as { boot: (url: string, port: number) => Promise<{ fetch?: (r: Request) => Promise<Response> }>; wakeHive?: () => void }
  M.wakeHive?.()
  const worker = await M.boot('', 0)
  ok('its Worker exports `fetch`', typeof worker?.fetch === 'function', String(Object.keys(worker ?? {})))
  if (typeof worker?.fetch !== 'function') return

  const ask = (p: string, init: RequestInit = {}) => worker.fetch!(new Request(`http://worker.test${p}`, { redirect: 'manual', ...init }))

  const made = await ask('/notes', { method: 'POST', headers: { ...FORM, ...OWNER }, body: formBody('from the worker') })
  ok('the Worker answers a POST to /notes with 303 to the new note', made.status === 303 && /^\/notes\/\d+$/.test(made.headers.get('location') ?? ''), `${made.status} ${made.headers.get('location')} ${await made.text()}`)

  const listed = await ask('/notes', { headers: OWNER })
  const listedBody = await listed.text()
  ok('and draws the list with the note on GET', listed.status === 200 && listedBody.includes('from the worker'), `${listed.status} ${listedBody.slice(0, 300)}`)

  const nobody = await ask('/notes', { method: 'POST', headers: FORM, body: formBody('x') })
  ok('and refuses a POST from nobody with 401', nobody.status === 401, String(nobody.status))

  fs.rmSync(root, { recursive: true, force: true })
}

// ---- 2. the node host, over HTTP ----

async function node(): Promise<void> {
  const text = fs.readFileSync(SITE, 'utf8')
  // `roll` and no tree shaking, as test/site/body.ts builds: the exception kinds `expose` reads (data-mismatch for a
  // 400) are registered by `wakeHive` only when the roll is kept
  const result = compile(
    { file: SITE, text },
    { resolve: projectResolver(NOTES, 'node'), env: 'node', deckOf: projectDeckOf(), roll: true, treeShake: false, roleOf: projectRoleOf(NOTES), leanOf: projectLeanOf(NOTES) } as never,
  )
  const said = result.ok ? '' : [...new Set(result.diagnostics.map(d => `${d.file?.split('/').pop()}:${d.span?.start?.line}: ${d.message}`))].slice(0, 8).join(' | ')
  ok('notes/code/site.tree compiles for the node host', result.ok, said)
  if (!result.ok) return
  if (process.env.NOTES_SITE_DUMP) fs.writeFileSync(process.env.NOTES_SITE_DUMP, result.typescript)

  // the emitted names: a task named in two files is split by file (`view` beside the dom's `view` is `viewIn00`)
  const ts = result.typescript
  ok('the list draws model.tree\'s `view` of its `replay` of the events taken', /rowsOf\(view\w*\(replay\(eventsOf\(log\)\), asker\)/.test(ts), '')
  ok('`replay` runs model.tree\'s `step`', /function replay\(es: Events\): Shelf \{[\s\S]{0,400}?step\w*\(replay\(/.test(ts), '')
  // a raising call records its Term frame in `__site` first (term/hive decision 001): `(__site = "<frame>", call)`
  ok('edit and delete ask permit.tree\'s `grant-delete` for the note\'s permit', (ts.match(/const p: Permit = (\(__site = "[^"]*", )?grantDelete\(asker, at, whose\)/g) ?? []).length === 2, '')
  ok('and delete spends that permit as the erase event', /log\.push\((eraseBy\(p\)|\{ form: "erase", who: p\.person\.id, rank: p\.person\.rank, id: p\.note \})\)/.test(ts), (/[^\n]*log\.push[^\n]*/.exec(ts) ?? [''])[0])

  const readRuntime = (p: string): string | undefined => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined)
  const prelude = nativePrelude(result.program, 'node', readRuntime, result.typescript)
  const dir = fs.mkdtempSync(path.join(TERM, 'test', 'tmp', 'notes-site-'))
  fs.writeFileSync(path.join(dir, 'app.ts'), `${prelude}\n${result.typescript}`)
  const bundled = await build({ entryPoints: [path.join(dir, 'app.ts')], bundle: true, format: 'esm', platform: 'node', external: ['hono', '@hono/node-server'], write: false })
  const file = path.join(dir, 'app.mjs')
  fs.writeFileSync(file, bundled.outputFiles[0].text)

  const M = (await import(pathToFileURL(file).href)) as { boot: (url: string, port: number) => unknown; wakeHive?: () => void }
  M.wakeHive?.()
  await M.boot('', PORT)
  await new Promise(r => setTimeout(r, 300))

  const at = (p: string, init: RequestInit = {}) => fetch(`http://localhost:${PORT}${p}`, { redirect: 'manual', ...init })

  // create
  const made = await at('/notes', { method: 'POST', headers: { ...FORM, ...OWNER }, body: formBody('buy bread') })
  const where = made.headers.get('location') ?? ''
  ok('POST /notes writes a note and answers 303 to it', made.status === 303 && /^\/notes\/\d+$/.test(where), `${made.status} ${where} ${await made.text()}`)

  // list
  const list = await at('/notes', { headers: OWNER })
  const listBody = await list.text()
  ok('GET /notes lists the note, linked to its page', list.status === 200 && listBody.includes('buy bread') && listBody.includes(`href="${where}"`), listBody.slice(0, 400))

  // show
  const shown = await at(where, { headers: OWNER })
  const shownBody = await shown.text()
  ok('GET /notes/:id shows the note with its edit and delete forms', shown.status === 200 && shownBody.includes('buy bread') && shownBody.includes(`action="${where}/delete"`), shownBody.slice(0, 400))

  // isolation, through the routes: another person's list and page do not show it
  const otherList = await (await at('/notes', { headers: OTHER })).text()
  const otherPage = await (await at(where, { headers: OTHER })).text()
  ok("another person's list and the note's page, asked by them, do not show it", !otherList.includes('buy bread') && !otherPage.includes('buy bread'), `${otherList.slice(0, 200)} ${otherPage.slice(0, 200)}`)
  const nobodyList = await (await at('/notes')).text()
  ok('a request from nobody sees no notes', !nobodyList.includes('buy bread'))

  // edit, by POST (an HTML form) and by PATCH
  const edited = await at(where, { method: 'POST', headers: { ...FORM, ...OWNER }, body: formBody('buy rye bread') })
  ok('POST /notes/:id by its owner retitles it and answers 303', edited.status === 303 && edited.headers.get('location') === where, `${edited.status} ${edited.headers.get('location')} ${await edited.text()}`)
  const patched = await at(where, { method: 'PATCH', headers: { 'content-type': 'application/json', ...OWNER }, body: JSON.stringify({ title: 'buy rye bread and milk' }) })
  ok('PATCH /notes/:id with a JSON body retitles it too', patched.status === 303, `${patched.status} ${await patched.text()}`)
  const afterEdit = await (await at(where, { headers: OWNER })).text()
  ok('the page shows the new title', afterEdit.includes('buy rye bread and milk'), afterEdit.slice(0, 300))

  // a hostile title comes back escaped, in the list and on its page
  const hostile = '<script>alert("x")</script> & \'q\''
  const evil = await at('/notes', { method: 'POST', headers: { ...FORM, ...OWNER }, body: formBody(hostile) })
  const evilAt = evil.headers.get('location') ?? ''
  const evilList = await (await at('/notes', { headers: OWNER })).text()
  const evilPage = await (await at(evilAt, { headers: OWNER })).text()
  ok('a title holding <script> is escaped in the list', evilList.includes('&lt;script&gt;') && !evilList.includes('<script>alert'), evilList.slice(0, 600))
  const evilBody = /<body>[\s\S]*<\/body>/.exec(evilPage)?.[0] ?? evilPage
  ok('and on its page as text', /<h1><span[^>]*>&lt;script&gt;alert\("x"\)&lt;\/script&gt; &amp; 'q'<\/span><\/h1>/.test(evilBody), `${evilAt} ${evilBody.slice(0, 1200)}`)
  // in a double-quoted attribute only `"` and `&` can end or change it, and the node serializer's `escapeAttr` escapes
  // both: the `<script>` stays inside the value, inert
  ok('and in the edit field, inside a value attribute whose quotes and ampersands are escaped', evilBody.includes(`value="<script>alert(&quot;x&quot;)</script> &amp; 'q'"`), evilBody.slice(0, 1200))
  ok('and the page holds no script element but the host\'s own', (evilPage.match(/<script[ >]/g) ?? []).length === (evilBody.match(/value="<script>/g) ?? []).length + 2, evilPage.slice(0, 1200))
  // a URL percent-encodes `<`, `>` and `"` in a path, and leaves `&` and `'` as written: those reach the refusal page
  const evilPath = await at("/notes/x&y'z", { method: 'DELETE', headers: OWNER })
  const evilPathBody = await evilPath.text()
  ok('a refusal page puts the path it names through escape-html', evilPath.status === 404 && evilPathBody.includes('x&amp;y&#39;z') && !evilPathBody.includes("x&y'z"), `${evilPath.status} ${evilPathBody}`)

  // without a permit: another member is refused, nobody is refused, and the note is still there
  const forged = await at(where, { method: 'DELETE', headers: OTHER })
  ok("DELETE of another person's note by a member is refused 403: grant-delete gives no permit", forged.status === 403, `${forged.status} ${await forged.text()}`)
  const forgedEdit = await at(where, { method: 'PATCH', headers: { 'content-type': 'application/json', ...OTHER }, body: JSON.stringify({ title: 'mine now' }) })
  ok("PATCH of another person's note by a member is refused 403", forgedEdit.status === 403, `${forgedEdit.status} ${await forgedEdit.text()}`)
  const anonymous = await at(where, { method: 'DELETE' })
  ok('DELETE from nobody is refused 401', anonymous.status === 401, String(anonymous.status))
  const anonymousMake = await at('/notes', { method: 'POST', headers: FORM, body: formBody('who am i') })
  ok('POST /notes from nobody is refused 401', anonymousMake.status === 401, String(anonymousMake.status))
  const stillThere = await (await at(where, { headers: OWNER })).text()
  ok('after the refusals the note is still there, with its title', stillThere.includes('buy rye bread and milk'), stillThere.slice(0, 300))

  // a bad body
  const plain = await at('/notes', { method: 'POST', headers: { 'content-type': 'text/plain', ...OWNER }, body: 'title=x' })
  ok('a text/plain body answers 415', plain.status === 415, `${plain.status} ${await plain.text()}`)
  const misfit = await at('/notes', { method: 'POST', headers: { 'content-type': 'application/json', ...OWNER }, body: JSON.stringify({ name: 'no title field' }) })
  ok('a JSON body that does not fit the form answers 400', misfit.status === 400, `${misfit.status} ${await misfit.text()}`)
  const broken = await at('/notes', { method: 'POST', headers: { 'content-type': 'application/json', ...OWNER }, body: '{"title": ' })
  ok('a JSON body that does not parse answers 400', broken.status === 400, `${broken.status} ${await broken.text()}`)
  const empty = await at('/notes', { method: 'POST', headers: { ...FORM, ...OWNER }, body: 'title=' })
  ok('an empty title answers 400', empty.status === 400, `${empty.status} ${await empty.text()}`)

  // a method no task serves
  const put = await at('/notes', { method: 'PUT', headers: OWNER, body: '' })
  ok('PUT /notes answers 405 naming GET, HEAD, POST', put.status === 405 && put.headers.get('allow') === 'GET, HEAD, POST', `${put.status} ${put.headers.get('allow')}`)

  // delete, by the owner through the HTML form route, and by an admin through DELETE
  const removed = await at(`${where}/delete`, { method: 'POST', headers: OWNER })
  ok('POST /notes/:id/delete by its owner erases it and answers 303 to the list', removed.status === 303 && removed.headers.get('location') === '/notes', `${removed.status} ${removed.headers.get('location')} ${await removed.text()}`)
  const afterDelete = await (await at('/notes', { headers: OWNER })).text()
  const pageAfter = await (await at(where, { headers: OWNER })).text()
  ok('the erased note is in neither the list nor its page (law 4, through the routes)', !afterDelete.includes('buy rye bread') && !pageAfter.includes('buy rye bread'), afterDelete.slice(0, 300))
  const again = await at(where, { method: 'DELETE', headers: OWNER })
  ok('deleting it again answers 404', again.status === 404, String(again.status))

  const byAdmin = await at(evilAt, { method: 'DELETE', headers: ADMIN })
  ok("an admin may delete another person's note: 303", byAdmin.status === 303, `${byAdmin.status} ${await byAdmin.text()}`)
  const ownerAfterAdmin = await (await at('/notes', { headers: OWNER })).text()
  ok('and it is gone from its owner\'s list', !ownerAfterAdmin.includes('&lt;script&gt;'), ownerAfterAdmin.slice(0, 300))

  fs.rmSync(dir, { recursive: true, force: true })
}

async function main(): Promise<void> {
  fs.mkdirSync(path.join(TERM, 'test', 'tmp'), { recursive: true })
  await node()
  await cast()
  finish()
}

main().catch(error => {
  ok('the suite ran', false, String(error?.stack ?? error))
  finish()
})
