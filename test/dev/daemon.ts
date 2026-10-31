// Daemon test (Tier 4). Starts the real daemon and drives it over HTTP: analyze a document (warm), get its
// diagnostics, re-analyze after an edit (still warm, re-checked incrementally), report a real type error, and drop a
// document. Proves the shared warm-analyzer process end to end. Run: npx tsx test/dev/daemon.ts
//
// The daemon builds through build-request in document mode (item term-self-host-001-0414): a question's text is the
// graph's overlay for its file, so an unsaved file is read by another document's import until the client closes it,
// and the daemon's store is the machine store, which must still take writes after another process reclaims the
// daemon's namespace (item 0471, here in a daemon that keeps running). `DAEMON_PORT=<path>` runs a draft port instead.
// The whole test runs on a store of its own (TERM_CACHE_HOME), never the machine's.

import * as path from 'node:path'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HOME = mkdtempSync(path.join(tmpdir(), 'term-daemon-home-'))
process.env.TERM_CACHE_HOME = HOME

const { startDaemon } = (await import(process.env.DAEMON_PORT ?? '@term/call/code/dev/daemon')) as {
  startDaemon: (options: { root: string; port?: number; env?: string }) => { port: number; warm: () => number; close: () => void }
}

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

// the toolchain's own folder, which a draft run from tmp/ names (`DAEMON_SEED`)
const SEED = process.env.DAEMON_SEED ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const PORT = 39631
const FILE = path.join(SEED, 'daemon-doc.tree') // a path; text is supplied per request, no disk read needed

const callerSrc = `task caller\n  like number\n  send back\n    call helper\n      code 5\n`
const helperOk = `task helper\n  take n, like number\n  like number\n  send back\n    read n\n`
const helperBad = `task helper\n  take n, like number\n  like number\n  send back\n    text <oops>\n`

type Diagnostics = { diagnostics: { name?: string; message: string; severity?: string }[] }

async function postTo(port: number, endpoint: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`http://localhost:${port}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  return { status: r.status, json: await r.json() }
}

const post = (endpoint: string, body: unknown) => postTo(PORT, endpoint, body)

async function get(endpoint: string): Promise<any> {
  return (await fetch(`http://localhost:${PORT}${endpoint}`)).json()
}

// every file under a folder, counted
function filesUnder(dir: string): number {
  if (!existsSync(dir)) return 0

  return readdirSync(dir).reduce((sum, name) => {
    const full = path.join(dir, name)

    return sum + (statSync(full).isDirectory() ? filesUnder(full) : 1)
  }, 0)
}

async function main(): Promise<void> {
  const daemon = startDaemon({ root: SEED, port: PORT, env: 'node' })
  await new Promise(r => setTimeout(r, 250))

  // a clean document: no diagnostics
  const clean = await post('/analyze', { file: FILE, text: `${helperOk}\n${callerSrc}` })

  ok('daemon analyzes a clean document (no diagnostics)', clean.status === 200 && clean.json.diagnostics.length === 0, JSON.stringify(clean.json))

  // the document is now warm
  const health1 = await get('/health')
  ok('the document is kept warm', health1.warm === 1, JSON.stringify(health1))

  // edit it to introduce a real type error -> reported, still one warm document
  const broken = await post('/analyze', { file: FILE, text: `${helperBad}\n${callerSrc}` })

  ok(
    'daemon reports a real type error after an edit',
    broken.json.diagnostics.some((d: { message: string }) => d.message.includes('expected')),
    JSON.stringify(broken.json.diagnostics),
  )

  const health2 = await get('/health')
  ok('still one warm document after the edit', health2.warm === 1)

  // fix it again -> clean
  const fixed = await post('/analyze', { file: FILE, text: `${helperOk}\n${callerSrc}` })

  ok('daemon clears the error when fixed', fixed.json.diagnostics.length === 0, JSON.stringify(fixed.json.diagnostics))

  // the build's checks: a load of a `mark private` task from another file is refused, as `term make` refuses it. The
  // analyzer the daemon ran until 2026-10-05 answered nothing for it (guides: commands/work)
  {
    const project = mkdtempSync(path.join(tmpdir(), 'term-daemon-'))
    mkdirSync(path.join(project, 'code'))
    writeFileSync(path.join(project, 'deck.tree'), 'deck @probe/daemon\n  mark <0.0.1>\n')
    writeFileSync(path.join(project, 'code/secret.tree'), 'task scale\n  mark private\n  take n, like number\n  like number\n  back multiply(n, 3)\n')
    const reach = 'load ./secret\n  find scale\n\ntask tripled\n  like number\n\n  back scale(4)\n'
    writeFileSync(path.join(project, 'code/reach.tree'), reach)

    const private_ = startDaemon({ root: project, port: PORT + 1, env: 'node' })
    await new Promise(r => setTimeout(r, 250))

    const answer = (await postTo(PORT + 1, '/analyze', { file: 'code/reach.tree', text: reach })).json as Diagnostics

    ok(
      'daemon refuses a private task loaded from another file, as term make does',
      answer.diagnostics.some(d => /mark private/.test(d.message)),
      JSON.stringify(answer.diagnostics),
    )

    // AN UNSAVED FILE IS THE OVERLAY'S: a file only the client holds is read by another document's load, until the
    // client closes it, and then the load finds nothing, as `term make` would
    const drafted = 'task drafted\n  like number\n  send back, code 7\n'
    const user = 'load ./draft\n  find drafted\n\ntask used\n  like number\n  send back\n    call drafted\n'
    writeFileSync(path.join(project, 'code/user.tree'), user)
    const unsaved = (await postTo(PORT + 1, '/analyze', { file: 'code/draft.tree', text: drafted })).json as Diagnostics
    ok('an unsaved file builds', unsaved.diagnostics.length === 0, JSON.stringify(unsaved.diagnostics))
    const reading = (await postTo(PORT + 1, '/analyze', { file: 'code/user.tree', text: user })).json as Diagnostics
    ok("another document's load reads the unsaved file", reading.diagnostics.length === 0, JSON.stringify(reading.diagnostics))
    await postTo(PORT + 1, '/close', { file: 'code/draft.tree' })
    const closed = (await postTo(PORT + 1, '/analyze', { file: 'code/user.tree', text: user })).json as Diagnostics
    ok(
      'once the unsaved file is closed, the load finds nothing (its overlay entry dropped)',
      closed.diagnostics.some(d => d.severity !== 'warning'),
      JSON.stringify(closed.diagnostics),
    )
    // and opened again after a load of it found nothing: the walk that found nothing is not kept
    await postTo(PORT + 1, '/analyze', { file: 'code/draft.tree', text: drafted })
    const reopened = (await postTo(PORT + 1, '/analyze', { file: 'code/user.tree', text: user })).json as Diagnostics
    ok('an unsaved file opened again after it was closed is read', reopened.diagnostics.length === 0, JSON.stringify(reopened.diagnostics))
    // a load that found nothing, and then the file it names opened unsaved: the walk that found nothing is not kept
    const later = 'load ./later\n  find drafted\n\ntask used-later\n  like number\n  send back\n    call drafted\n'
    writeFileSync(path.join(project, 'code/later-user.tree'), later)
    const missing = (await postTo(PORT + 1, '/analyze', { file: 'code/later-user.tree', text: later })).json as Diagnostics
    ok('a load of a file nobody holds finds nothing', missing.diagnostics.some(d => d.name === 'unresolved-load'), JSON.stringify(missing.diagnostics))
    await postTo(PORT + 1, '/analyze', { file: 'code/later.tree', text: drafted })
    const found = (await postTo(PORT + 1, '/analyze', { file: 'code/later-user.tree', text: later })).json as Diagnostics
    ok('once that file is opened unsaved, the same text reads it', found.diagnostics.length === 0, JSON.stringify(found.diagnostics))

    // THE STORE OUTLIVES A RECLAIM (item 0471, here in a daemon that keeps running): another process's
    // reclaimStaleVersions removes the daemon's unit namespace, and the daemon's next build still lands in the store
    const units = path.join(HOME, 'unit')
    const before = filesUnder(units)
    ok('the daemon writes its units to the machine store', before > 0, `${before} files under ${units}`)
    rmSync(units, { recursive: true, force: true })
    const edited = 'load ./secret\n  find scale\n\ntask tripled\n  like number\n\n  back scale(5)\n'
    writeFileSync(path.join(project, 'code/reach.tree'), edited)
    await postTo(PORT + 1, '/analyze', { file: 'code/reach.tree', text: edited })
    const after = filesUnder(units)
    ok('after the namespace is removed while the daemon runs, its next build is written again', after > 0, `${after} files under ${units}`)

    private_.close()
    rmSync(project, { recursive: true, force: true })
  }

  // bad request handling
  const bad = await post('/analyze', { nope: true })
  ok('daemon rejects a malformed request', bad.status === 400)

  // closing the document drops its warm state
  await post('/close', { file: FILE })

  const health3 = await get('/health')
  ok('closing a document drops its warm state', health3.warm === 0)

  daemon.close()
  rmSync(HOME, { recursive: true, force: true })
  console.log(`\ndev/daemon: ${pass} pass, ${fail} fail`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
