// THE LANGUAGE SERVER ON THE BUILD'S ENGINE (decision 098 of note/project/term/self-host/change/001-finish-self-host,
// item term-self-host-001-0413), driven through the server's ports with the messages an editor sends:
//
//   turns       1,000 keystrokes with no file event turn no graph's session; one created-file event turns it once,
//               on the next request; a client that registers watchers is asked to send `**/*.tree` events
//   store       a dirty file's keystrokes write no unit, mill or scan entry to the store; the request after its save
//               writes the unit
//   roots       a document in a second package root gets a graph of its own, and one outside every package is
//               analyzed with nothing written into its folder
//
// Run: npx tsx test/server/store-clean.ts

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// the machine store of this run, before any module reads it
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'term-store-clean-')))
process.env.TERM_CACHE_HOME = join(scratch, 'home')

const unwrap = (module: unknown): any => (module as { default?: unknown }).default ?? module
const ls = unwrap(await import('@term/flow/code/language-server'))
const rl = unwrap(await import('@term/flow/code/request-loop'))

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

let nextId = 1
type Server = { record: any; send: (message: Record<string, unknown>) => Promise<any[]> }

async function serve(watching: boolean): Promise<Server> {
  const record = ls.makeLanguageServer({})
  const send = (message: Record<string, unknown>) => rl.dispatch(record, { jsonrpc: '2.0', ...message })
  const capabilities = {
    textDocument: { diagnostic: {} },
    ...(watching ? { workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } } : {}),
  }
  await send({ id: nextId++, method: 'initialize', params: { capabilities } })

  return { record, send }
}

const pull = async (server: Server, uri: string): Promise<{ severity: number; message: string; source?: string }[]> => {
  const answer = await server.send({ id: nextId++, method: 'textDocument/diagnostic', params: { textDocument: { uri } } })
  return (answer.find(m => m.result)?.result?.items ?? []).filter((d: { source?: string }) => d.source === 'term')
}

const packageAt = (name: string): string => {
  const root = join(scratch, name)
  mkdirSync(join(root, 'code'), { recursive: true })
  writeFileSync(join(root, 'deck.tree'), `deck @test/${name}\n  mark <0.0.0>\n`)
  return root
}

// every file under a folder, with its text
function filesUnder(folder: string): string[] {
  if (!existsSync(folder)) return []
  const out: string[] = []
  for (const name of readdirSync(folder)) {
    const at = join(folder, name)
    if (statSync(at).isDirectory()) out.push(...filesUnder(at))
    else out.push(at)
  }
  return out
}

// the store files that hold a text: the machine store and the package's own
const holding = (root: string, marker: string): string[] =>
  [...filesUnder(process.env.TERM_CACHE_HOME!), ...filesUnder(join(root, '.base'))].filter(file => {
    const bytes = readFileSync(file)
    // an entry may be stored packed (gzip's magic bytes)
    const text = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8')
    return text.includes(marker)
  })

const turnsOf = (server: Server, root: string): number => server.record.graphs.get(root)?.graph.session.turns ?? -1

// ---- turns ----
{
  const root = packageAt('turns')
  const file = join(root, 'code', 'edit.tree')
  const textOf = (n: number): string => `task bench-count\n  like number\n  send back, code ${n}\n`
  writeFileSync(file, textOf(0))
  const uri = pathToFileURL(file).href
  const server = await serve(true)

  const registered = await server.send({ method: 'initialized', params: {} })
  ok(
    'turns: a client that registers watchers is asked for **/*.tree events',
    registered.some(
      m =>
        m.method === 'client/registerCapability' &&
        m.params.registrations[0].method === 'workspace/didChangeWatchedFiles' &&
        m.params.registrations[0].registerOptions.watchers[0].globPattern === '**/*.tree',
    ),
    JSON.stringify(registered),
  )

  await server.send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'tree', version: 1, text: textOf(0) } } })
  await pull(server, uri)
  const before = turnsOf(server, root)
  const started = Date.now()
  for (let n = 1; n <= 1000; n++) {
    await server.send({ method: 'textDocument/didChange', params: { textDocument: { uri, version: n + 1 }, contentChanges: [{ text: textOf(n) }] } })
    await pull(server, uri)
  }
  const after = turnsOf(server, root)
  ok('turns: 1,000 keystrokes with no file event turn the session 0 times', before === 0 && after === 0, `before ${before}, after ${after}, ${Date.now() - started} ms`)

  // a file created on disk, then one more keystroke: one turn
  const made = join(root, 'code', 'made.tree')
  writeFileSync(made, 'task made-one\n  like number\n  send back, code 1\n')
  await server.send({ method: 'workspace/didChangeWatchedFiles', params: { changes: [{ uri: pathToFileURL(made).href, type: 1 }] } })
  await server.send({ method: 'textDocument/didChange', params: { textDocument: { uri, version: 2000 }, contentChanges: [{ text: textOf(2000) }] } })
  await pull(server, uri)
  await server.send({ method: 'textDocument/didChange', params: { textDocument: { uri, version: 2001 }, contentChanges: [{ text: textOf(2001) }] } })
  await pull(server, uri)
  ok('turns: one created-file event turns the session once', turnsOf(server, root) === 1, `turns ${turnsOf(server, root)}`)

  // the created file is read: a load of it builds
  const loads = 'load ./made\n  find made-one\n\ntask use-made\n  like number\n  send back, call made-one\n'
  await server.send({ method: 'textDocument/didChange', params: { textDocument: { uri, version: 2002 }, contentChanges: [{ text: loads }] } })
  const found = await pull(server, uri)
  ok('turns: after the turn a load of the created file builds', found.filter(d => d.severity === 1).length === 0, JSON.stringify(found))
}

// ---- store ----
{
  const root = packageAt('store')
  const file = join(root, 'code', 'dirty.tree')
  const marker = 'store-clean-marker'
  const textOf = (n: number): string => `task ${marker}-${n}\n  like number\n  send back, code ${n}\n`
  writeFileSync(file, textOf(0))
  const uri = pathToFileURL(file).href
  const server = await serve(true)
  await server.send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'tree', version: 1, text: textOf(0) } } })
  await pull(server, uri)

  for (let n = 1; n <= 20; n++) {
    await server.send({ method: 'textDocument/didChange', params: { textDocument: { uri, version: n + 1 }, contentChanges: [{ text: textOf(n) }] } })
    await pull(server, uri)
  }
  const dirty = holding(root, `${marker}-20`)
  ok("store: a dirty file's keystrokes write no unit, mill or scan entry", dirty.length === 0, dirty.join(', '))
  ok('store: the clean open wrote its unit', holding(root, `${marker}-0`).length > 0)

  // saved: the disk holds the text, and the next request writes its unit
  writeFileSync(file, textOf(20))
  await server.send({ method: 'textDocument/didSave', params: { textDocument: { uri } } })
  await pull(server, uri)
  const saved = holding(root, `${marker}-20`)
  ok('store: the request after the save writes the unit', saved.some(one => one.includes('/unit/')), saved.join(', '))
}

// ---- a held unit and a project request (item term-self-host-001-0530) ----
{
  const bg = unwrap(await import('@term/call/code/work/build/build-graph'))
  const { projectCache } = unwrap(await import('@term/call/code/work/cache/compile-store'))
  const root = packageAt('held')
  const file = join(root, 'code', 'held.tree')
  const marker = 'held-unit-marker'
  const textOf = (n: number): string => `task ${marker}-${n}\n  like number\n  send back, code ${n}\n`
  const other = join(root, 'code', 'other.tree')
  writeFileSync(file, textOf(0))
  writeFileSync(other, 'task other-one\n  like number\n  send back, code 1\n')
  const ask = (mode: string, at = '') => ({ mode, file: at, platform: 'node', precomputed: undefined, explain: undefined })
  // a cap of one answer: the document's unit is gone from the memo by the time the project request wants it
  const graph = bg.makeBuildGraph(root, 1)
  const store = projectCache(root)
  bg.buildRequest(graph, ask('project'), store)

  bg.setOverlay(graph, file, textOf(1))
  const looked = bg.buildRequest(graph, ask('document', file), store)
  const lookedBuilt = looked.answer.result?.built?.length ?? 0
  ok('held: the dirty unit is built by the document request', lookedBuilt > 0, String(lookedBuilt))
  ok('held: and the store does not take it', holding(root, `${marker}-1`).length === 0)

  writeFileSync(file, textOf(1))
  bg.dropOverlay(graph, file)
  const built = bg.buildRequest(graph, ask('project'), store).build
  ok('held: the project request after the save reads it from the store and builds nothing', built.built === 0, `built ${built.built}, reused ${built.reused}`)
  ok('held: the store took it', holding(root, `${marker}-1`).some(one => one.includes('/unit/')))
}

// ---- roots ----
{
  const one = packageAt('first')
  const two = packageAt('second')
  const loose = join(scratch, 'loose')
  mkdirSync(loose)
  const server = await serve(true)
  const docs: [string, string][] = [
    [join(one, 'code', 'a.tree'), 'task in-first\n  like number\n  send back, code 1\n'],
    [join(two, 'code', 'b.tree'), 'task in-second\n  like number\n  send back, call not-defined-anywhere\n'],
    [join(loose, 'c.tree'), 'load @term/base/text\n  find trim\n\ntask outside\n  like text\n  send back\n    call trim\n      text < x >\n'],
  ]
  const answers: number[] = []
  for (const [file, text] of docs) {
    writeFileSync(file, text)
    const uri = pathToFileURL(file).href
    await server.send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'tree', version: 1, text } } })
    answers.push((await pull(server, uri)).filter(d => d.severity === 1).length)
  }
  const roots = [...server.record.graphs.keys()].sort()
  ok('roots: one graph per package root, and the loose file its folder', JSON.stringify(roots) === JSON.stringify([one, two, loose].sort()), JSON.stringify(roots))
  ok('roots: the first package builds clean', answers[0] === 0, String(answers[0]))
  ok('roots: the second package reports its own error', answers[1]! > 0, String(answers[1]))
  ok('roots: a file outside every package builds against the stdlib', answers[2] === 0, String(answers[2]))
  ok('roots: nothing is written into the loose folder', !existsSync(join(loose, '.base')))
}

rmSync(scratch, { recursive: true, force: true })

console.log(`\nserver/store-clean: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
