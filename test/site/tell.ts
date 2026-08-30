// The funnel of note/term/hive/06-tell.md, live: `expose` turns a raised exception into the response the app's
// `tell` table decided at build time, the status table maps the seventeen, and the `/errors` pages come from the
// roll. Compiles a small app against the real stdlib and @term/site, wakes its hive, raises, and reads the wire.
// Run: npx tsx test/site/tell.ts

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transform } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
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

// an app: two exceptions under `excess`, one told with a prop and a public name, one private, and a route
const APP = `load @term/seed/code/exception
  find excess

load @term/site/code/http/tell
  find expose
  find status-of
  find case-of
  find case-path
  find note-key
  find errors-page
  find error-page

form upload-excess
  like excess
    bind note, <File too large>
    link secret, like(text), need false
    link api-key, like(text), need false

form quota-excess
  like excess
    bind note, <Quota exceeded>
    link secret, like(text), need false
    link api-key, like(text), need false

task upload
  take size, like number
  like number
  halt upload-excess
    bind thing, text <upload>
    bind limit, code 5
    bind actual, read size

task reserve
  like number
  halt quota-excess
    bind thing, text <quota>

# a one-line stdlib task nothing else calls is inlined away by the simplifier, so the app calls it from a task of its own
task key-of
  take host, like text
  take form, like text
  like text
  send back
    call note-key
      read host
      read form

tell @probe/tell/upload-excess
  note <That file is too large>
  hint <Files may be up to 5 MB>
  link limit
  link actual
  name too-large
`

async function main(): Promise<void> {
  // a package of its own, so the tells name a real deck (`@probe/tell`), linking the stdlib and the site framework
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term-tell-'))
  fs.mkdirSync(path.join(root, 'link/@term'), { recursive: true })
  fs.mkdirSync(path.join(root, 'code'), { recursive: true })
  fs.symlinkSync(path.join(TERM, 'deck/seed'), path.join(root, 'link/@term/seed'))
  fs.symlinkSync(path.join(TERM, 'deck/site'), path.join(root, 'link/@term/site'))
  fs.writeFileSync(path.join(root, 'deck.tree'), 'deck @probe/tell\n  code <0.0.0>\n')
  const entry = path.join(root, 'code/app.tree')
  fs.writeFileSync(entry, APP)

  const result = compile(
    { file: entry, text: APP },
    { resolve: projectResolver(root, 'node'), deckOf: projectDeckOf(), roll: true, treeShake: false },
  )

  ok('the app compiles with its tell', result.ok, result.ok ? '' : result.diagnostics.map(d => `${d.file?.split('/').pop()}: ${d.message}`).join(' | '))

  if (!result.ok) {
    console.log(`\ntell: ${pass} pass, ${fail} fail`)
    process.exit(1)
  }

  // the json module docks `<global:json>`: the native prelude goes first, as `term boot` prepends it
  const prelude = nativePrelude(result.program, 'node', (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined))
  const js = (await transform(`${prelude}\n${result.typescript}`, { loader: 'ts', format: 'esm' })).code
  const file = path.join(root, 'app.mjs')
  fs.writeFileSync(file, js)

  const M = (await import(pathToFileURL(file).href)) as {
    wakeHive: () => void
    TermException: new (base: Record<string, unknown>) => unknown
    upload: (size: number) => number
    reserve: () => number
    expose: (e: unknown) => { status: number; body: string }
    statusOf: (c: string) => number
    caseOf: (n: string) => string
    casePath: (c: string) => string
    keyOf: (h: string, f: string) => string
    errorsPage: () => { status: number; body: string }
    errorPage: (c: string) => { status: number; body: string }
  }

  M.wakeHive()

  ok('the status table maps the seventeen', M.statusOf('absence') === 404 && M.statusOf('excess') === 413 && M.statusOf('timeout') === 504 && M.statusOf('bundle') === 500)
  ok('a case is snake on the wire', M.caseOf('upload-excess') === 'upload_excess')
  ok('a case path is kebab', M.casePath('upload_excess') === '/errors/upload-excess')
  ok('the site text key is exception/<host>/<form>/note', M.keyOf('@probe/tell', 'upload-excess') === 'exception/@probe/tell/upload-excess/note', M.keyOf('@probe/tell', 'upload-excess'))

  let told: { status: number; body: string } | undefined

  try {
    M.upload(9)
  } catch (e) {
    told = M.expose(e)
  }

  const toldBody = told ? (JSON.parse(told.body) as Record<string, unknown>) : {}
  ok('a told exception answers with the status of its root', told?.status === 413, String(told?.status))
  ok('a told exception carries its public name as the case, snake on the wire', toldBody.case === 'too_large', told?.body)
  ok('a told exception carries the note the tell wrote', toldBody.note === 'That file is too large', told?.body)
  ok('a told exception carries the props the tell named', toldBody.limit === 5 && toldBody.actual === 9, told?.body)
  ok('a told exception leaves the unnamed prop out', !('thing' in toldBody), told?.body)
  ok('the occurrence code rides along', typeof toldBody.code === 'string' && /^[a-z]{8}(-[a-z]{8}){3}$/.test(String(toldBody.code)), String(toldBody.code))
  ok('hint is not on the wire', !('hint' in toldBody), told?.body)

  let hidden: { status: number; body: string } | undefined

  try {
    M.reserve()
  } catch (e) {
    hidden = M.expose(e)
  }

  const hiddenBody = hidden ? (JSON.parse(hidden.body) as Record<string, unknown>) : {}
  ok('a private exception answers with the status of its root', hidden?.status === 413, String(hidden?.status))
  ok('a private exception says which of the seventeen it is', hiddenBody.case === 'excess', hidden?.body)
  ok('a private exception carries no note and no props', !('note' in hiddenBody) && !('thing' in hiddenBody) && typeof hiddenBody.code === 'string', hidden?.body)

  const index = M.errorsPage()
  ok('/errors lists every told exception', index.status === 200 && index.body.includes('/errors/too-large') && index.body.includes('That file is too large') && !index.body.includes('quota'), index.body)

  const page = M.errorPage('too-large')
  ok('/errors/<case> shows note, hint, props and status', page.status === 200 && page.body.includes('Files may be up to 5 MB') && page.body.includes('<code>limit</code>') && page.body.includes('status 413'), page.body)
  ok('/errors/<unknown> is an absence', M.errorPage('nothing').status === 404)

  // the bait test of mesh/task/error/check.ts, against the roll: EVERY exception of the build is raised with bait
  // props named `secret` and `api-key`, and nothing that comes out of `expose` carries the bait, told or private.
  // Exhaustive over the roll, not sampled, because the whole point is the one form nobody thought about.
  const BAIT = 'kvmtnhbs-bait-value'
  const leaked: string[] = []
  const rolled = (result.roll?.exception ?? []) as { host: string; name: string }[]

  for (const entry of rolled) {
    const raised = new M.TermException({
      host: entry.host,
      form: entry.name,
      note: 'bait',
      code: 'kvmtnhbs-rzdxfwlc-mnbdtkhs-fvzxcwlr',
      time: 0,
      link: { secret: BAIT, apiKey: BAIT, thing: BAIT, limit: 1, actual: 2 },
    })
    const out = M.expose(raised)

    if (out.body.includes(BAIT) || out.body.includes('secret') || out.body.includes('apiKey') || out.body.includes('api_key')) {
      leaked.push(`${entry.host}/${entry.name}: ${out.body}`)
    }
  }

  ok(`no exception on the roll leaks a bait prop through expose (${rolled.length} raised)`, rolled.length >= 2 && leaked.length === 0, leaked.join(' | '))

  console.log(`\ntell: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }
}

main()
