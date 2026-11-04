// THE INCREMENTAL BUILD EQUALS THE CLEAN BUILD ON EVERY CALLER'S PATH (`pnpm term:edit-replay-callers`, decision 077
// section 10 of note/project/term/self-host/change/001-finish-self-host, item term-self-host-001-0406).
//
// task/term/edit-replay.ts holds one caller to a clean build: a kept BuildSession in one process. Every other caller
// reaches the unit engine its own way, and this drives one seeded edit sequence through each of them, on its own copy
// of the package and its own store, and after every edit compares what each answered with a CLEAN build of the same
// sources: a fresh copy, an empty store, a fresh process.
//
//   session   one BuildSession and one cache in this process for the whole sequence (call/code/make.ts, as edit-replay)
//   fresh     `term make` in a new process per edit (the CLI: work/build/build-command.tree, its probe, its pool)
//   pool      the same CLI with the probe turned off, so every build goes through the worker pool (unit-pool.tree)
//   watch     one `term make --watch` for the whole sequence (tree-watching.tree's pump loop), fed by the real file
//             events of each edit; its problems are the last rebuild's, its artifacts what is on disk once it is quiet
//
// Compared after every edit: every artifact under host/ byte for byte (the project's own path read as <root>), and every
// error and warning with its text, code, file, line and column, in order. The CLI adapters are compared with a clean
// `term make --log json --all`; the session with a clean compileProjectSeparate in a fresh process (its diagnostics are
// the engine's, not the printer's). Both clean builds' artifacts must also agree with each other.
//
// The edits: edit-replay's nine kinds (a comment, a task added, its body, its signature, it removed, a file saved
// unchanged, a file added that loads another, one shelved, one put back), plus a whitespace-only edit, an exported task
// renamed with its callers, a role.tree change, a same-size edit made at once after the build (the racy stamp), and a
// file that fails the build, mended by the next such edit (`break`, item 0429).
//   server    the editor's server (the ports language-server.tree, request-loop.tree) in this process: each edited
//             document as an unsaved change, then saved, its compiler diagnostics against the clean build's in that file
//   daemon    the dev daemon, `term work` in its own process (work/serve/compile-daemon.tree), `POST /analyze` of each
//             edited document, likewise; a warning of another file answered for the document is a difference
//   rust      `term make --emit rust <document> --out <folder> --units` by a kept store, against the same at the same
//             path on an empty store (a native unit's file name holds the folder's name and a hash of its path)
//   test      `term test --log json` in a process of its own per edit, its store kept (work/testing/test-command.tree,
//             one build graph a run, item 0495), against the same on a clean copy: each file's step, counts, problems
//   boot      term boot in this process (work/boot/boot-running.tree, its one build graph kept across the sequence as
//             the dev loop keeps it, item 0495), the deck's console into a fresh --out folder each edit, against a
//             clean `term boot --out` in a process of its own: every file of the bundle
// And a file moved between directories (code/ to code/moved/ and back): its old path removed on every copy.
// And a one-statement task with two importers, one whose hold unfolds it (a consult of its carried shape) and one that
// only calls it (`add-consulted`), then its body edited (`consulted-body`, decision 103 item 5 of
// term/self-host/change/001-finish-self-host): the trace verify mode's case, a shape one importer reads and one does not.
//   graph     the build graph and its one entry (work/build/build-graph.tree, item 0409, no caller switched yet): one
//             graph and one store in this process for the sequence. Each edited document first as an unsaved text over
//             the disk (`build-request`, mode document), against a fresh graph building it from the disk of a clean
//             copy (mode entry); then the edit written, the overlay dropped, and the project built (mode project),
//             against the clean engine build. With `session` listed BEFORE it, the units built and reused must equal
//             the kept session's
//   graph-cap the same with a unit memo capped at one answer, so the memo starts over at every request
//   graph-fresh a new graph in a new process per edit (`--graph-child`), one project request each: it starts from the
//             persisted snapshot the last one wrote (build-graph.tree `load-snapshot`, item 0410), against the clean
//             engine build
// And two edits to the snapshot itself (item 0410), each with a comment written: it removed (`lose-snapshot`), or cut
// short (`corrupt-snapshot`), in every copy that has one. Either must cost time and never an answer.
//
// And two edits that change nothing a build reads twice over (item 0468): `noop` writes nothing at all, and every
// adapter builds; `racy` is a same-size edit the fresh adapter writes within 1 s of the end of its OWN build of the
// state before it (decision 077 section 10), which every other adapter takes as written.
//
// NO ADAPTER PASSES WITHOUT RUNNING ITS PATH (item 0468). The watch must rebuild after every edit that changed some
// file's text; the pool adapter's every build must go through the pool; the rust adapter's clean side is a fresh copy
// at the same path on an empty home (the kept copy moved aside meanwhile), and an edit with no edited document emits the
// project's entry; the server's and the daemon's diagnostics are compared in their order, document by document. Each
// gate has a deliberate break that must fail it, re-runnable: `--break watch-stop` stops the watch after its first
// build, `--break pool-off` builds the pool adapter with the plain CLI (the probe on, so a small edit builds in process),
// `--break racy-late` writes the racy edit 1.5 s after the fresh build, `--break server-order` reverses the server's
// diagnostics (an in-order compare must see it wherever a document has two).
//
//   pnpm term:edit-replay-callers                              deck/zone, 20 edits, seeds 1 2 3, every adapter
//   pnpm term:edit-replay-callers --seeds 7 --edits 40 --adapters fresh,pool deck/host
//   --verify <modes>   TERM_CACHE_VERIFY for every build (default ledger,hits,twice,trace; `off` for none), items 0407, 0415
//   --break <name>     a deliberate break of one gate (above), which must read as a difference
//
// Writes only under the system temporary directory. Verdict: one line per adapter, `N edits, M builds compared, K differ`.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { makeScratch, removeTree, scratchEnv, sweepStaleRuns } from './temp-run'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TERM_ROOT, parentRoot } from './root'

const TERM = TERM_ROOT
const REPO = TERM_ROOT
const LINE = path.join(TERM, 'host', 'line.js')
const STDLIB = path.join(TERM, 'deck', 'base')

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`)

  return at >= 0 ? args[at + 1] : undefined
}

type Diag = string
type Answer = { diags: Diag[]; artifacts: Map<string, string>; note?: string }

// short, because these folders now sit inside the run's scratch folder and a Unix socket path holds 104 bytes on macOS
const fresher = (prefix: string): string => realpathSync(mkdtempSync(path.join(tmpdir(), `rc-${prefix}-`)))

// Every copy and home of a run sits in one scratch folder (temp-run.ts), removed when the run ends and swept by the next
// run if this one is killed: thousands of replay-callers-* folders were left in the system temp folder, which a
// concurrent term:test reported as its own temp-leak (item 0528). `--keep-temp` keeps them to look at a difference. The
// children (`--clean-child`, ...) inherit TMPDIR and make no scratch of their own
const openScratch = (): void => {
  sweepStaleRuns()
  const scratch = makeScratch('tp')

  Object.assign(process.env, scratchEnv(scratch))

  process.on('exit', () => {
    if (args.includes('--keep-temp')) {
      console.error(`kept: ${scratch}`)
    } else {
      removeTree(scratch)
    }
  })
}

// the deliberate break of one gate (`--break`), which must read as a difference
const BREAKS = ['watch-stop', 'pool-off', 'racy-late', 'server-order']
const breaking = flag('break')
if (breaking !== undefined && !BREAKS.includes(breaking)) throw new Error(`edit-replay-callers: --break is one of ${BREAKS.join(', ')}`)

// every artifact under host/, the project's path read as <root>
function artifacts(root: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return

    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)

      if (statSync(full).isDirectory()) walk(full)
      else out.set(path.relative(root, full), readFileSync(full, 'utf8').split(root).join('<root>'))
    }
  }

  walk(path.join(root, 'host'))

  return out
}

// ---- the clean build in the engine's own channel, as a child (`--clean-child <root>`) ----

const problemsOf = (root: string, problems: { diagnostic: { severity?: string; name?: string; message?: string; span?: { file?: string; start?: { line: number; column: number } } } }[]): Diag[] =>
  problems.map(({ diagnostic: d }) => `${d.severity}|${d.name}|${d.span?.file ? path.relative(root, d.span.file) : ''}:${d.span?.start?.line}:${d.span?.start?.column}|${d.message}`)

async function cleanChild(root: string): Promise<void> {
  const { buildSession, compileProjectSeparate } = await import('@term/call/code/make')
  const { projectCache } = await import('@term/call/code/cache-store')
  const built = compileProjectSeparate(root, projectCache(root), 'node', buildSession(root))
  console.log(JSON.stringify({ child: problemsOf(root, built.problems as never) }))
}

// ---- the build graph (work/build/build-graph.tree, item 0409): its port, called as a caller will call it ----

type GraphPort = {
  makeBuildGraph: (root: string, unitCap?: number) => unknown
  buildRequest: (graph: unknown, ask: Record<string, unknown>, store?: unknown) => { form: string; build?: { problems: unknown[]; built: number; reused: number }; answer?: { ok: boolean; problems: unknown[]; faults: string[] } }
  setOverlay: (graph: unknown, file: string, text: string) => void
  dropOverlay: (graph: unknown, file: string) => void
}

async function graphPort(): Promise<GraphPort> {
  // REPLAY_GRAPH_MODULE runs a draft's emitted TypeScript before it lands (tmp/self-host/0409/emit.sh)
  const emitted = await import(process.env.REPLAY_GRAPH_MODULE || '@term/call/code/work/build/build-graph')

  return ((emitted as { default?: unknown }).default ?? emitted) as GraphPort
}

const ask = (mode: string, file = ''): Record<string, unknown> => ({ mode, file, platform: 'node', precomputed: undefined, explain: undefined })

// a document request's answer as lines: whether it built, its refusals, its problems as the project build frames them
function documentLines(root: string, rel: string, answer: { ok: boolean; problems: unknown[]; faults: string[] }): Diag[] {
  return [`${rel} ok ${answer.ok}`, ...answer.faults.map(f => `${rel} fault ${f}`), ...problemsOf(root, answer.problems as never).map(d => `${rel} ${d}`)]
}

// the clean side of a document request: each document built from the disk (entry mode) by a fresh graph, on a fresh
// copy and an empty store, in a process of its own (`--clean-doc <root> <rels as JSON>`)
async function cleanDocChild(root: string, rels: string[]): Promise<void> {
  const port = await graphPort()
  const graph = port.makeBuildGraph(root)
  const lines: Diag[] = []

  for (const rel of rels) {
    const answered = port.buildRequest(graph, ask('entry', path.join(root, rel)))
    lines.push(...documentLines(root, rel, answered.answer!))
  }

  console.log(JSON.stringify({ child: lines }))
}

// one project request by a new graph, in a process of its own (`--graph-child <root>`), as a fresh `term make` will make
// it once it is switched (item 0412): the graph starts from the project's snapshot when it validates
async function graphChild(root: string): Promise<void> {
  const port = await graphPort()
  const graph = port.makeBuildGraph(root)
  const answered = port.buildRequest(graph, ask('project'))
  const built = answered.build!
  console.log(JSON.stringify({ child: problemsOf(root, built.problems as never), built: built.built, reused: built.reused }))
}

// ---- the CLI, in a process of its own ----

function cli(line: string, root: string, home: string): { diags: Diag[]; pool: boolean; exit: number } {
  const made = spawnSync(process.execPath, [line, 'make', '--log', 'json', '--all'], {
    cwd: root,
    env: { ...process.env, TERM_CACHE_HOME: home, TERM_STDLIB: STDLIB },
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
  const events = made.stdout
    .split('\n')
    .filter(one => one.startsWith('{'))
    .map(one => JSON.parse(one) as { kind?: string; glyph?: string; code?: string; subject?: string; fields?: Record<string, string> })

  return {
    diags: events.filter(e => e.kind === 'problem').map(e => `${e.glyph}|${e.code ?? ''}|${e.fields?.file ?? ''}|${e.subject}|${e.fields?.next ?? ''}`),
    pool: events.some(e => e.subject === 'units in parallel'),
    exit: made.status ?? -1,
  }
}

// `term make --emit rust <file> --out <folder> --units`: its exit, its problems, and every file it wrote, as lines (the
// folder's own path read as <out>), so two emissions compare as diagnostics do
function emitUnits(root: string, rel: string, home: string, label: string): Diag[] {
  const out = path.join(root, 'host', 'replay-units', label, rel.replace(/[/.]/g, '-'))
  const made = spawnSync(process.execPath, [LINE, 'make', '--emit', 'rust', rel, '--out', out, '--units', '--log', 'json'], {
    cwd: root,
    env: { ...process.env, TERM_CACHE_HOME: home, TERM_STDLIB: STDLIB },
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
  const problems = made.stdout
    .split('\n')
    .filter(one => one.startsWith('{'))
    .map(one => JSON.parse(one) as { kind?: string; glyph?: string; code?: string; subject?: string; fields?: Record<string, string> })
    .filter(e => e.kind === 'problem')
    .map(e => `${rel} ${e.glyph}|${e.code ?? ''}|${e.fields?.file ?? ''}|${e.subject}`)
  const files: string[] = []
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else files.push(`${rel} file ${path.relative(out, full)} ${readFileSync(full, 'utf8').split(out).join('<out>').split(root).join('<root>')}`)
    }
  }
  walk(out)

  return [`${rel} exit ${made.status}`, ...problems, ...files]
}

// ---- term test and term boot (item 0495): each builds through a build graph (decision 094 rule 1) ----

// `term test --log json` in a process of its own: each file's step with its counts, each problem, and the close, times
// and the project's own path left out (the run's open line names the folder, and is not compared)
function testRun(root: string, home: string): Diag[] {
  const made = spawnSync(process.execPath, [LINE, 'test', '--log', 'json'], {
    cwd: root,
    env: { ...process.env, TERM_CACHE_HOME: home, TERM_STDLIB: STDLIB },
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
  const short = root.replace(require('node:os').homedir(), '~')

  return [
    ...made.stdout
      .split('\n')
      .filter(one => one.startsWith('{'))
      .map(one => JSON.parse(one) as { kind?: string; glyph?: string; verb?: string; subject?: string; counts?: unknown; fields?: Record<string, string>; message?: string[] })
      .filter(e => e.kind !== 'open')
      .map(e => `${e.kind}|${e.glyph}|${e.verb}|${e.subject}|${JSON.stringify(e.counts ?? {})}|${JSON.stringify(e.fields ?? {})}|${(e.message ?? []).join(' ')}`.split(root).join('<root>').split(short).join('<root>')),
    `exit ${made.status}`,
  ]
}

// the file the boot adapter boots: the deck's console (`line ./code/line`), else the project's entry
function bootEntry(truth: string): string {
  return existsSync(path.join(truth, 'code', 'line', 'base.tree')) ? path.join('code', 'line', 'base.tree') : projectEntry(truth)
}

// every file a boot wrote under its --out folder, the copy's path and the folder's read as <root> and <out>
function outFiles(out: string, root: string): Map<string, string> {
  const files = new Map<string, string>()
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else files.set(`boot ${path.relative(out, full)}`, readFileSync(full, 'utf8').split(out).join('<out>').split(root).join('<root>'))
    }
  }
  walk(out)

  return files
}

type BootPort = { callBoot: (input: Record<string, unknown>) => Promise<void>; readLastBootUnits: () => { built: number; reused: number } }

async function bootPort(): Promise<BootPort> {
  // REPLAY_BOOT_MODULE runs a draft's emitted TypeScript before it lands
  const emitted = await import(process.env.REPLAY_BOOT_MODULE || '@term/call/host/port/code/work/boot/boot-running')

  return ((emitted as { default?: unknown }).default ?? emitted) as BootPort
}

// a boot in this process (term boot's dev loop: the process's one graph kept across every edit), into a fresh --out
// folder. It prints its own build card into the replay's output
async function bootHere(port: BootPort, root: string, home: string, rel: string, out: string): Promise<void> {
  const was = { home: process.env.TERM_CACHE_HOME, stdlib: process.env.TERM_STDLIB, exit: process.exitCode }
  process.env.TERM_CACHE_HOME = home
  process.env.TERM_STDLIB = STDLIB
  try {
    await port.callBoot({ root, entry: path.join(root, rel), out })
  } finally {
    process.env.TERM_CACHE_HOME = was.home
    if (was.stdlib === undefined) delete process.env.TERM_STDLIB
    else process.env.TERM_STDLIB = was.stdlib
    process.exitCode = was.exit
  }
}

// the clean side: `term boot <rel> --out` in a process of its own, on a clean copy and an empty store
function bootClean(root: string, home: string, rel: string, out: string): number {
  return spawnSync(process.execPath, [LINE, 'boot', rel, '--out', out, '--log', 'json'], {
    cwd: root,
    env: { ...process.env, TERM_CACHE_HOME: home, TERM_STDLIB: STDLIB },
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  }).status ?? -1
}

// the CLI with the separate build's probe turned off: the pool on every build of 16 files or more
function poolLine(): string {
  const text = readFileSync(LINE, 'utf8')
  // build-command.tree's three spellings of the pool's options (item 0428): the plain probe, the probe a snapshot
  // narrows, and the plain probe again when the session's turn starts it over
  const at = 'probe: true'

  if (text.split(at).length !== 4) throw new Error('edit-replay-callers: the probe options are not in host/line.js exactly three times')

  // inside the package, so the bundle's bare imports (esbuild, the node_modules it leaves external) resolve as
  // host/line.js's do; named by its content, so a second run reuses it and nothing is overwritten
  const body = text.split(at).join('probe: false')
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  const dir = path.join(TERM, 'tmp', 'edit-replay-callers')
  const out = path.join(dir, `line-pool-${createHash('sha256').update(body).digest('hex').slice(0, 16)}.js`)
  mkdirSync(dir, { recursive: true })

  if (!existsSync(out)) writeFileSync(out, body)

  return out
}

// ---- the watch: one `term make --watch` for the whole sequence, fed by real file events ----

type Watch = { mark: () => void; settle: (wanted: boolean) => Promise<{ diags: Diag[]; rebuilt: boolean }>; stop: () => void }

// The watch prints each rebuild's problems, then its `build` step. After an edit, wait for a build step, then for the
// stream to stay quiet for QUIET ms (an edit that writes two files may build twice); an edit that changed no text may
// build nothing, and after NONE ms with no build the state as it stands is compared
function watching(root: string, home: string): Watch {
  const { spawn } = require('node:child_process') as typeof import('node:child_process')
  const child = spawn(process.execPath, [LINE, 'make', '--watch', '--log', 'json', '--all'], {
    cwd: root,
    env: { ...process.env, TERM_CACHE_HOME: home, TERM_STDLIB: STDLIB },
  })
  const QUIET = 2500
  const NONE = 15000
  let pending: Diag[] = []
  let last: Diag[] = []
  let builds = 0
  // the builds counted when the edit was written, so a rebuild during the clean builds is still this edit's
  let marked = 0
  let heard = Date.now()
  let buffer = ''

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop()!

    for (const one of lines) {
      if (!one.startsWith('{')) continue

      const e = JSON.parse(one) as { kind?: string; glyph?: string; code?: string; verb?: string; subject?: string; fields?: Record<string, string> }
      heard = Date.now()

      if (e.kind === 'problem') pending.push(`${e.glyph}|${e.code ?? ''}|${e.fields?.file ?? ''}|${e.subject}|${e.fields?.next ?? ''}`)
      else if (e.kind === 'step' && e.verb === 'build') {
        last = pending
        pending = []
        builds++
      }
    }
  })

  const wait = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))

  return {
    mark: () => {
      marked = builds
    },
    settle: async wanted => {
      const before = marked
      const started = Date.now()

      while (builds === before && Date.now() - started < (wanted ? NONE * 4 : NONE)) await wait(100)

      while (Date.now() - heard < QUIET) await wait(100)

      return { diags: last, rebuilt: builds > before }
    },
    stop: () => {
      child.kill('SIGTERM')
    },
  }
}

// ---- the daemon: `term work` (work/small/worker-start.tree, work/serve/compile-daemon.tree) in a process of its own,
// as it runs for a client. In this process it shared the thread the clean builds block, and a question asked after a
// block past its 5 s keep-alive read ECONNRESET (item 0424) ----

async function daemonChild(root: string, home: string): Promise<{ port: number; close: () => void }> {
  const { spawn } = require('node:child_process') as typeof import('node:child_process')
  const port = 21000 + Math.floor(Math.random() * 4000)
  const child = spawn(process.execPath, [LINE, 'work', '--port', String(port), '--log', 'json'], {
    cwd: root,
    env: { ...process.env, TERM_CACHE_HOME: home, TERM_STDLIB: STDLIB },
  })
  let heard = ''

  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`edit-replay-callers: term work said nothing of port ${port} in 60 s\n${heard.slice(-2000)}`)), 60000)
    const listen = (chunk: Buffer): void => {
      heard += chunk.toString()

      if (heard.includes(`localhost:${port}`)) {
        clearTimeout(timer)
        done()
      }
    }
    child.stdout.on('data', listen)
    child.stderr.on('data', listen)
    child.on('exit', code => {
      clearTimeout(timer)
      fail(new Error(`edit-replay-callers: term work exited ${code}\n${heard.slice(-2000)}`))
    })
  })

  return { port, close: () => child.kill('SIGTERM') }
}

// ---- the language server: the editor's ports (language-server.tree, request-loop.tree), in this process ----

// a CLI problem line in the server's own form: its name, the place, and the message as the editor shows it (the first
// letter lower, the next step in parentheses)
function serverForm(diags: Diag[]): Diag[] {
  return diags.map(d => {
    const parts = d.split('|')
    const [glyph, code, file] = [parts[0]!, parts[1]!, parts[2]!]
    const next = parts.at(-1)!
    const subject = parts.slice(3, -1).join('|')
    const place = file.replace(/^.*?:(\d+:\d+)$/, '$1')
    const severity = glyph === 'warning' ? 'warning' : glyph === 'info' ? 'info' : 'error'

    return `${severity}|${code}|${place}|${subject.charAt(0).toLowerCase()}${subject.slice(1)}${next ? ` (${next})` : ''}`
  })
}

// the file of a CLI problem line, its place cut off
const fileOf = (d: Diag): string => d.split('|')[2]!.replace(/:\d+:\d+$/, '')

type Server = { look: (changes: Change[]) => Promise<{ rel: string; unsaved: Diag[]; saved: Diag[] }[]> }

async function serving(root: string): Promise<Server> {
  const { pathToFileURL } = await import('node:url')
  const emittedServer = await import('@term/flow/code/language-server')
  const emittedLoop = await import('@term/flow/code/request-loop')
  const ls = ((emittedServer as { default?: unknown }).default ?? emittedServer) as { makeLanguageServer: (given: unknown) => unknown }
  const rl = ((emittedLoop as { default?: unknown }).default ?? emittedLoop) as { dispatch: (server: unknown, message: unknown) => Promise<{ result?: { items?: unknown[] } }[]> }
  const server = ls.makeLanguageServer({})
  let id = 1
  const send = (message: Record<string, unknown>) => rl.dispatch(server, { jsonrpc: '2.0', ...message })
  const open = new Map<string, number>()
  // a client with file watchers (VS Code's, deck/flow/code/extension.ts), so the server turns on its events alone
  await send({ id: id++, method: 'initialize', params: { capabilities: { textDocument: { diagnostic: {} }, workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } } } })

  // the compiler's diagnostics of a document (the lint's are the editor's own, and no build prints them)
  const pull = async (uri: string): Promise<Diag[]> => {
    const answer = await send({ id: id++, method: 'textDocument/diagnostic', params: { textDocument: { uri } } })
    const items = (answer[0]?.result?.items ?? []) as { range: { start: { line: number; character: number } }; severity: number; source?: string; message: string; data?: { name?: string } }[]

    return items
      .filter(item => item.source === 'term')
      .map(item => `${item.severity === 1 ? 'error' : item.severity === 2 ? 'warning' : 'info'}|${item.data?.name ?? ''}|${item.range.start.line + 1}:${item.range.start.character + 1}|${item.message}`)
  }

  return {
    look: async changes => {
      const out: { rel: string; unsaved: Diag[]; saved: Diag[] }[] = []
      const documents = documentsOf(changes)

      // unsaved: the editor's text changes, the disk does not yet
      for (const change of documents) {
        const file = path.join(root, change.rel)
        const uri = pathToFileURL(file).href
        const version = (open.get(uri) ?? 0) + 1

        if (!open.has(uri)) {
          await send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'tree', version, text: existsSync(file) ? readFileSync(file, 'utf8') : '' } } })
        }

        open.set(uri, version + 1)
        await send({ method: 'textDocument/didChange', params: { textDocument: { uri, version: version + 1 }, contentChanges: [{ text: change.text }] } })
      }

      for (const change of documents) out.push({ rel: change.rel, unsaved: await pull(pathToFileURL(path.join(root, change.rel)).href), saved: [] })

      // saved: every change on disk (role.tree among them), told to the server as a client's file watcher tells it
      // (`**/*.tree`, decision 098: the server turns on these, never per keystroke), then each document saved
      const events: { uri: string; type: number }[] = []
      for (const change of changes) {
        if (change.snapshot !== undefined || !change.rel.endsWith('.tree')) {
          apply(root, change)
          continue
        }
        const file = path.join(root, change.rel)
        const existed = existsSync(file)
        apply(root, change)
        const type = change.text === undefined ? 3 : existed ? 2 : 1
        if (change.text !== undefined || existed) events.push({ uri: pathToFileURL(file).href, type })
      }
      if (events.length > 0) await send({ method: 'workspace/didChangeWatchedFiles', params: { changes: events } })

      for (const change of documents) {
        const uri = pathToFileURL(path.join(root, change.rel)).href
        await send({ method: 'textDocument/didSave', params: { textDocument: { uri }, text: change.text } })
      }

      for (const one of out) one.saved = await pull(pathToFileURL(path.join(root, one.rel)).href)

      return out
    },
  }
}

// ---- the edits ----

function editsFor(seed: number) {
  let state = seed >>> 0
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)]!

  return { random, pick }
}

// a file written with `text`, or removed when `text` is undefined (a move removes its old path). `snapshot` is an edit to
// the copy's own graph snapshots (item 0410), which only a build of that copy wrote: each removed, or cut short
type Change = { rel: string; text: string | undefined; snapshot?: 'lose' | 'corrupt' }

// where a copy's graph snapshots are, one per compiler (build-graph.tree `snapshot-path`)
const SNAPSHOTS = path.join('.base', '@term', 'code', 'cache', 'graph')

// a change made on a copy: written, or removed
function apply(root: string, change: Change): void {
  const at = path.join(root, change.rel)

  if (change.snapshot !== undefined) {
    const folder = path.join(root, SNAPSHOTS)
    if (!existsSync(folder)) return
    for (const name of readdirSync(folder)) {
      const file = path.join(folder, name)
      if (change.snapshot === 'lose') rmSync(file, { force: true })
      else {
        const text = readFileSync(file, 'utf8')
        writeFileSync(file, text.slice(0, Math.floor(text.length / 2)))
      }
    }
    return
  }

  if (change.text === undefined) {
    rmSync(at, { force: true })
    return
  }

  mkdirSync(path.dirname(at), { recursive: true })
  writeFileSync(at, change.text)
}

// the changes a document reader is handed: a .tree under code/ written, never one removed
const documentsOf = (changes: Change[]): (Change & { text: string })[] =>
  changes.filter((change): change is Change & { text: string } => change.text !== undefined && change.rel.endsWith('.tree') && change.rel.startsWith('code/'))

// each changed path's size on a copy, -1 where absent: a racy edit must leave them as they were
const sizesOf = (root: string, changes: Change[]): string =>
  changes.map(change => (existsSync(path.join(root, change.rel)) ? statSync(path.join(root, change.rel)).size : -1)).join(',')

// the document the rust adapter emits when an edit edited none: code/base.tree, else the first program under code/
function projectEntry(truth: string): string {
  const { findTreeFiles } = require('@term/call/code/make') as typeof import('@term/call/code/make')
  const { declaresDraft } = require('@term/call/code/draft') as typeof import('@term/call/code/draft')
  const programs = findTreeFiles(path.join(truth, 'code'), [], 'node')
    .filter(file => !declaresDraft(readFileSync(file, 'utf8')))
    .map(file => path.relative(truth, file))
    .sort()

  return programs.includes(path.join('code', 'base.tree')) ? path.join('code', 'base.tree') : programs[0]!
}

// one edit on the truth copy: what it did, and every file it wrote (written to every adapter's copy alike). `script`,
// when given, names the kind of each edit in turn (cycling) instead of a seeded pick: `--kinds add-file,shelve-file`
// is item 0425's fail-first case, a file added and then shelved
function makeEditor(truth: string, seed: number, script: string[] = []) {
  const { random, pick } = editsFor(seed)
  const { findTreeFiles } = require('@term/call/code/make') as typeof import('@term/call/code/make')
  const { declaresDraft } = require('@term/call/code/draft') as typeof import('@term/call/code/draft')
  const originals = new Map(findTreeFiles(path.join(truth, 'code'), [], 'node').map(file => [file, readFileSync(file, 'utf8')]))
  const programs = [...originals.keys()].filter(file => !declaresDraft(originals.get(file)!))
  const added: { file: string; name: string; text: string }[] = []
  const files: string[] = []
  // tasks added with a caller in another file, for the rename
  const called: { file: string; caller: string; name: string }[] = []
  // one-statement tasks with one importer whose hold unfolds them and one that only calls them (decision 103 item 5)
  const consulted: { file: string; name: string; body: string }[] = []
  // the file a `break` edit wrote, which fails every build until the next `break` mends it (item 0429)
  let broken: string | undefined

  // `changed`: whether some file's text is not what it was (a watch must rebuild after it); `racy`: the fresh adapter
  // builds first and writes it at once after (item 0468)
  return (n: number): { said: string; changes: Change[]; changed: boolean; racy?: boolean } => {
    const changes: Change[] = []
    let changedText = false
    const write = (file: string, text: string): void => {
      if (!existsSync(file) || readFileSync(file, 'utf8') !== text) changedText = true
      writeFileSync(file, text)
      changes.push({ rel: path.relative(truth, file), text })
    }
    const remove = (file: string): void => {
      if (existsSync(file)) changedText = true
      rmSync(file, { force: true })
      changes.push({ rel: path.relative(truth, file), text: undefined })
    }
    const picked = ((): { said: string; changes: Change[]; racy?: boolean } => {
    const kinds = ['comment', 'add-task', 'touch', 'add-file', 'revert', 'whitespace', 'add-called', 'role', 'break', 'lose-snapshot', 'corrupt-snapshot', 'noop', 'add-consulted']

    if (added.length > 0) kinds.push('task-body', 'task-signature', 'remove-task', 'same-size', 'racy')
    if (files.length > 0) kinds.push('shelve-file', 'move-file', 'lose-record', 'foreign-record')
    if (called.length > 0) kinds.push('rename')
    if (consulted.length > 0) kinds.push('consulted-body')

    const scripted = script.length > 0 ? script[(n - 1) % script.length]! : undefined

    if (scripted !== undefined && !kinds.includes(scripted)) throw new Error(`edit-replay-callers: edit ${n} cannot be ${scripted} yet (${kinds.join(' ')})`)

    const kind = scripted ?? pick(kinds)
    const file = pick(programs)
    const text = readFileSync(file, 'utf8')
    const short = path.relative(truth, file)

    switch (kind) {
      case 'comment':
        write(file, `${text}\n# edit ${n}\n`)
        return { said: `a comment in ${short}`, changes }
      case 'whitespace':
        write(file, `${text}\n\n`)
        return { said: `blank lines in ${short}`, changes }
      case 'lose-snapshot':
      case 'corrupt-snapshot': {
        // the graph snapshot removed or cut short (item 0410), with a comment written so there is something to build
        write(file, `${text}\n# edit ${n}\n`)
        changes.push({ rel: SNAPSHOTS, text: undefined, snapshot: kind === 'lose-snapshot' ? 'lose' : 'corrupt' })
        return { said: `a comment in ${short}, the graph snapshot ${kind === 'lose-snapshot' ? 'removed' : 'cut short'}`, changes }
      }
      case 'add-task': {
        const name = `replay-task-${n}`
        const task = `\ntask ${name}\n  like number\n  send back, code ${n}\n`
        added.push({ file, name, text: task })
        write(file, `${text}${task}`)
        return { said: `task ${name} added to ${short}`, changes }
      }
      case 'noop':
        // nothing written at all (`touch` rewrites the bytes and moves the stamp): every adapter builds the same state
        return { said: 'nothing changed', changes }
      case 'task-body':
      case 'same-size':
      case 'racy': {
        const one = pick(added)
        const now = readFileSync(one.file, 'utf8')
        // same-size: one digit for another, so the file keeps its size and is written in the second of the last build.
        // racy: the same edit, which the fresh adapter writes within 1 s of the end of its own build (item 0468)
        const changed =
          kind !== 'task-body'
            ? one.text.replace(/code (\d+)/, (_, value: string) => `code ${value.slice(0, -1)}${(Number(value.at(-1)) + 1) % 10}`)
            : one.text.replace(/code (\d+)/, (_, value) => `code ${Number(value) + 1000}`)
        write(one.file, now.replace(one.text, changed))
        one.text = changed
        if (kind === 'racy') return { said: `a racy same-size edit to ${one.name}`, changes, racy: true }
        return { said: `${kind === 'same-size' ? 'a same-size edit to' : 'the body of'} ${one.name}`, changes }
      }
      case 'task-signature': {
        const one = pick(added)
        const now = readFileSync(one.file, 'utf8')
        const changed = one.text.includes('take extra')
          ? one.text.replace('  take extra, like number, fall 0\n', '')
          : one.text.replace('  like number\n', '  take extra, like number, fall 0\n  like number\n')
        write(one.file, now.replace(one.text, changed))
        one.text = changed
        return { said: `the signature of ${one.name} changed`, changes }
      }
      case 'remove-task': {
        const one = added.splice(Math.floor(random() * added.length), 1)[0]!
        write(one.file, readFileSync(one.file, 'utf8').replace(one.text, ''))
        return { said: `task ${one.name} removed`, changes }
      }
      case 'touch':
        write(file, text)
        return { said: `${short} saved unchanged`, changes }
      case 'add-file': {
        const at = path.join(truth, 'code', `replay-file-${n}.tree`)
        const load = path.relative(path.dirname(at), file).replace(/\.tree$/, '')
        write(at, `load ./${load}\n\ntask replay-file-${n}\n  like number\n  send back, code ${n}\n`)
        files.push(at)
        return { said: `file ${path.relative(truth, at)} added, loading ${short}`, changes }
      }
      case 'add-called': {
        // a file defining a task, and a second file calling it by an import: the rename's material
        const name = `replay-called-${n}`
        const lib = path.join(truth, 'code', `replay-lib-${n}.tree`)
        const caller = path.join(truth, 'code', `replay-use-${n}.tree`)
        write(lib, `task ${name}\n  take n, like number\n  like number\n  send back, read n\n`)
        write(caller, `load ./replay-lib-${n}\n  find ${name}\n\ntask replay-use-${n}\n  like number\n  send back\n    call ${name}\n      code ${n}\n`)
        called.push({ file: lib, caller, name })
        return { said: `task ${name} added with a caller`, changes }
      }
      case 'add-consulted': {
        // a one-statement task its own unit carries as a stub's shape, an importer whose hold unfolds it (a consult,
        // decision 103) and an importer that only calls it: the material of `consulted-body`
        const name = `replay-bump-${n}`
        const lib = path.join(truth, 'code', `replay-bump-${n}.tree`)
        const body = '      read n\n      code 1\n'
        write(lib, `task ${name}\n  take n, like number\n  like number\n  send back\n    call add\n${body}`)
        write(
          path.join(truth, 'code', `replay-sure-${n}.tree`),
          `load ./replay-bump-${n}\n  find ${name}\n\ntask replay-sure-${n}\n  take n, like number\n  like number\n  hold is-equal(${name}(n), add(n, 1))\n  send back, read n\n`,
        )
        write(
          path.join(truth, 'code', `replay-plain-${n}.tree`),
          `load ./replay-bump-${n}\n  find ${name}\n\ntask replay-plain-${n}\n  take n, like number\n  like number\n  send back\n    call ${name}\n      read n\n`,
        )
        consulted.push({ file: lib, name, body })
        return { said: `task ${name} added with an importer that consults it and one that does not`, changes }
      }
      case 'consulted-body': {
        // the body edited (its two arguments swapped), still one statement and still what the consulting hold says
        const one = pick(consulted)
        const next = one.body === '      read n\n      code 1\n' ? '      code 1\n      read n\n' : '      read n\n      code 1\n'
        write(one.file, readFileSync(one.file, 'utf8').replace(one.body, next))
        one.body = next
        return { said: `the body of ${one.name}, which one importer consults`, changes }
      }
      case 'rename': {
        const one = pick(called)
        const next = `${one.name.replace(/-r\d+$/, '')}-r${n}`
        write(one.file, readFileSync(one.file, 'utf8').split(one.name).join(next))
        write(one.caller, readFileSync(one.caller, 'utf8').split(one.name).join(next))
        const said = `exported task ${one.name} renamed ${next} with its caller`
        one.name = next
        return { said, changes }
      }
      case 'break': {
        // a build that FAILS, then mended by the next break: what a failed build leaves in host/ (host/roll.json
        // among it) must be what a clean failing build leaves (item 0429)
        if (broken === undefined) {
          broken = path.join(truth, 'code', `replay-broken-${n}.tree`)
          write(broken, `task replay-broken-${n}\n  like number\n  send back, read replay-missing-${n}\n`)
          return { said: `file ${path.relative(truth, broken)} added, failing the build`, changes }
        }
        const at = broken
        broken = undefined
        write(at, readFileSync(at, 'utf8').replace(/send back, read replay-missing-\d+/, `send back, code ${n}`))
        return { said: `file ${path.relative(truth, at)} mended`, changes }
      }
      case 'role': {
        // role.tree read again: a comment changes no role, and every walk must still start over
        const at = path.join(truth, 'role.tree')
        write(at, `${existsSync(at) ? readFileSync(at, 'utf8') : ''}\n# replay ${n}\n`)
        return { said: 'role.tree changed', changes }
      }
      case 'shelve-file': {
        const at = files.splice(Math.floor(random() * files.length), 1)[0]!
        write(at, `mark draft\n${readFileSync(at, 'utf8')}`)
        return { said: `file ${path.relative(truth, at)} shelved`, changes }
      }
      case 'lose-record':
      case 'foreign-record': {
        // the artifact record lost (removed, or another root's) while a file is shelved: the shelved file's artifacts
        // must still go, by the full sweep a lost record costs (item 0433, decision 077 section 4)
        const at = files.splice(Math.floor(random() * files.length), 1)[0]!
        write(at, `mark draft\n${readFileSync(at, 'utf8')}`)
        const record = path.join(truth, '.base', '@term', 'code', 'artifacts.txt')
        if (kind === 'lose-record') remove(record)
        else {
          mkdirSync(path.dirname(record), { recursive: true })
          write(record, `# term artifacts /another/root\nhost/code/base.ts\n`)
        }
        return { said: `file ${path.relative(truth, at)} shelved, the artifact record ${kind === 'lose-record' ? 'removed' : 'another root\'s'}`, changes }
      }
      case 'move-file': {
        // a file moved between directories (decision 077 section 10): code/ to code/moved/ and back, its old path
        // removed and its load written again from the new place
        const at = files.splice(Math.floor(random() * files.length), 1)[0]!
        const old = readFileSync(at, 'utf8')
        const loaded = path.resolve(path.dirname(at), old.split('\n')[0]!.replace(/^load /, ''))
        const inMoved = path.basename(path.dirname(at)) === 'moved'
        const to = path.join(truth, 'code', ...(inMoved ? [] : ['moved']), path.basename(at))
        const load = path.relative(path.dirname(to), loaded)
        mkdirSync(path.dirname(to), { recursive: true })
        write(to, old.replace(/^load .*/, `load ${load.startsWith('.') ? load : `./${load}`}`))
        remove(at)
        files.push(to)
        return { said: `file ${path.relative(truth, at)} moved to ${path.relative(truth, to)}`, changes }
      }
      default: {
        write(file, originals.get(file)!)
        for (let i = added.length - 1; i >= 0; i--) if (added[i]!.file === file) added.splice(i, 1)
        return { said: `${short} put back as it was`, changes }
      }
    }
    })()

    return { ...picked, changed: changedText }
  }
}

// ---- the replay ----

function copySources(from: string, to: string): string {
  mkdirSync(to, { recursive: true })

  for (const part of ['deck.tree', 'role.tree', 'code', 'test']) {
    if (existsSync(path.join(from, part))) cpSync(path.join(from, part), path.join(to, part), { recursive: true })
  }

  return realpathSync(to)
}

function differences(a: Answer, b: Answer): string[] {
  const out: string[] = []

  for (const file of new Set([...a.artifacts.keys(), ...b.artifacts.keys()])) {
    const [x, y] = [a.artifacts.get(file), b.artifacts.get(file)]

    if (x !== y) {
      const [xs, ys] = [(x ?? '').split('\n'), (y ?? '').split('\n')]
      const at = ys.findIndex((one, i) => one !== xs[i])
      out.push(`artifact ${file}${x === undefined ? ' missing' : y === undefined ? ' extra' : ` first at line ${at + 1}: ${(xs[at] ?? '').slice(0, 160)} | clean: ${(ys[at] ?? '').slice(0, 160)}`}`)
    }
  }

  const n = Math.max(a.diags.length, b.diags.length)

  for (let i = 0; i < n; i++) {
    if (a.diags[i] !== b.diags[i]) {
      // a long entry (an emitted file) shown at its first differing line
      const [xs, ys] = [(a.diags[i] ?? '(none)').split('\n'), (b.diags[i] ?? '(none)').split('\n')]
      const at = Math.max(0, xs.findIndex((one, k) => one !== ys[k]))
      const head = xs.length > 1 ? `${xs[0]!.slice(0, 120)} ... line ${at + 1}: ` : ''
      // a long line shown from a little before its first differing character, so the difference is in view
      const [x, y] = [xs[at] ?? '', ys[at] ?? '(none)']
      let c = 0
      while (c < x.length && x[c] === y[c]) c++
      const from = c > 160 ? c - 60 : 0
      const cut = (one: string): string => `${from > 0 ? '...' : ''}${one.slice(from, from + 200)}`
      out.push(`diagnostic ${i} of ${a.diags.length} vs ${b.diags.length}: ${head}${cut(x)} | clean: ${cut(y)}`)
      break
    }
  }

  return out
}

async function replay(): Promise<void> {
  const valued = new Set(['--seeds', '--edits', '--adapters', '--kinds', '--verify', '--break'])
  const script = (flag('kinds') ?? '').split(',').filter(Boolean)
  // TERM_CACHE_VERIFY on every build of the replay, this process's and every child's (decision 077 section 10, item
  // 0407): a stored answer that differs from its rebuild, or a unit that builds two ways, raises and so differs from
  // the clean build, and a read a unit's key does not cover fails that unit (`ledger`). `--verify off` runs without it
  // `trace` too (decision 103 item 5): every unit built again with what its trace does not hold stripped
  const verify = flag('verify') ?? 'ledger,hits,twice,trace'
  if (verify === 'off') delete process.env.TERM_CACHE_VERIFY
  else process.env.TERM_CACHE_VERIFY = verify
  const pkg = args.filter((arg, i) => !arg.startsWith('--') && !valued.has(args[i - 1] ?? ''))[0] ?? `${parentRoot()}/deck/zone`
  const seeds = (flag('seeds') ?? '1,2,3').split(',').map(Number)
  const edits = Number(flag('edits') ?? 20)
  const adapters = (flag('adapters') ?? 'session,fresh,pool').split(',')
  const { buildSession, compileProjectSeparate } = await import('@term/call/code/make')
  const { projectCache } = await import('@term/call/code/cache-store')
  const pooled = adapters.includes('pool') ? poolLine() : ''
  const booter = adapters.includes('boot') ? await bootPort() : undefined
  const graphed = adapters.includes('graph') || adapters.includes('graph-cap')
  const port = graphed ? await graphPort() : undefined
  // the graph's store as the CLI's port makes it (work/cache/compile-store.tree), once for the sequence
  const storeOf = graphed
    ? (((m: { default?: unknown }) => (m.default ?? m) as { projectCache: (root: string) => unknown })(await import('@term/call/code/work/cache/compile-store'))).projectCache
    : undefined
  const verdict = new Map<string, { edits: number; builds: number; differ: number; pools: number }>(adapters.map(a => [a, { edits: 0, builds: 0, differ: 0, pools: 0 }]))
  let failed = false
  // the seeds during which the compiler moved
  const unmeasured: number[] = []

  openScratch()
  console.log(`edit-replay-callers: ${pkg}, seeds ${seeds.join(' ')}, ${edits} edits each, adapters ${adapters.join(' ')}, verify ${verify}`)

  // THE COMPILER MUST HOLD STILL (item 0468): a make:line of another session during a seed hands the clean builds and
  // every fresh process a new compiler while the kept session, the watch and the daemon run the old one, so every later
  // compare is of two compilers (seed 3 of the first 0468 proof read 35 differences that way, a re-export order changed
  // by a landing at 20:22). A seed during which host/line.js moved is NOT MEASURED, and the run fails saying so
  const lineStamp = (): string => {
    const stat = statSync(LINE)
    return `${stat.size}:${stat.mtimeMs}`
  }

  for (const seed of seeds) {
    const lineAtStart = lineStamp()
    const truth = copySources(path.resolve(REPO, pkg), fresher('truth'))
    const copies = new Map(adapters.map(a => [a, copySources(truth, fresher(a))]))
    const homes = new Map(adapters.map(a => [a, fresher(`${a}-home`)]))
    const edit = makeEditor(truth, seed, script)
    // the session's process state: its store is its own home
    process.env.TERM_CACHE_HOME = homes.get('session') ?? fresher('session-home')
    const session = copies.has('session') ? buildSession(copies.get('session')!) : undefined
    const sessionCache = copies.has('session') ? projectCache(copies.get('session')!) : undefined
    const watch = copies.has('watch') ? watching(copies.get('watch')!, homes.get('watch')!) : undefined
    const server = copies.has('server') ? await serving(copies.get('server')!) : undefined
    const daemon = copies.has('daemon') ? await daemonChild(copies.get('daemon')!, homes.get('daemon')!) : undefined
    // the build graph (item 0409): `graph` with the server's cap, `graph-cap` with a cap of one unit answer, so its unit
    // memo starts over at every request. Each keeps one graph and one store for the sequence, its store its own home
    const graphs = new Map<string, { graph: unknown; store: unknown; home: string }>()
    for (const adapter of adapters.filter(a => a === 'graph' || a === 'graph-cap')) {
      const home = homes.get(adapter)!
      const was = process.env.TERM_CACHE_HOME
      process.env.TERM_CACHE_HOME = home
      const graph = port!.makeBuildGraph(copies.get(adapter)!, adapter === 'graph-cap' ? 1 : undefined)
      const store = storeOf!(copies.get(adapter)!)
      process.env.TERM_CACHE_HOME = was
      graphs.set(adapter, { graph, store, home })
    }
    // the session's units this edit, which a graph's project request must equal
    let sessionCounts: string | undefined

    for (let n = 0; n <= edits; n++) {
      const { said, changes, changed, racy } = n === 0 ? { said: 'the first build', changes: [] as Change[], changed: false, racy: false } : edit(n)

      sessionCounts = undefined

      if (n > 0) watch?.mark()

      for (const [adapter, copy] of copies) {
        // the server's copy is written after its unsaved look (`serverAnswer`), and a graph's after its document
        // requests on the unsaved texts; a racy edit's fresh copy right after its own build (below)
        if (adapter === 'server' || graphs.has(adapter) || (racy && adapter === 'fresh')) continue

        for (const change of changes) apply(copy, change)
      }

      // the clean builds: a fresh copy and an empty store each, in a fresh process
      const cleanRoot = copySources(truth, fresher('clean'))
      const cleanCli = cli(LINE, cleanRoot, fresher('clean-home'))
      const clean: Answer = { diags: cleanCli.diags, artifacts: artifacts(cleanRoot) }
      let cleanTs: Answer | undefined

      if (copies.has('session') || copies.has('graph-fresh') || graphs.size > 0) {
        const tsRoot = copySources(truth, fresher('clean-ts'))
        const ran = spawnSync(process.execPath, [...process.execArgv, process.argv[1]!, '--clean-child', tsRoot], {
          cwd: TERM,
          env: { ...process.env, TERM_CACHE_HOME: fresher('clean-ts-home') },
          encoding: 'utf8',
          maxBuffer: 1 << 28,
        })
        const line = ran.stdout.split('\n').find(one => one.startsWith('{"child"'))
        if (!line) throw new Error(`edit-replay-callers: the clean child answered nothing\n${ran.stderr.slice(-2000)}`)
        cleanTs = { diags: (JSON.parse(line) as { child: Diag[] }).child, artifacts: artifacts(tsRoot) }
        // host/roll.json is the CLI's own (build-command.tree write-roll), never the engine's
        const apart = differences(cleanTs, clean).filter(one => one.startsWith('artifact') && !one.startsWith('artifact host/roll.json'))
        if (apart.length > 0) {
          failed = true
          console.log(`  seed ${seed} after ${said}: the two clean builds' artifacts differ (engine vs CLI): ${apart[0]}`)
        }
      }

      for (const adapter of adapters) {
        const root = copies.get(adapter)!
        let answer: Answer
        let reference = clean

        if (adapter === 'session') {
          const built = compileProjectSeparate(root, sessionCache, 'node', session)
          answer = { diags: problemsOf(root, built.problems as never), artifacts: artifacts(root) }
          reference = cleanTs!
          sessionCounts = `${built.built} built, ${built.reused} reused`
        } else if (graphs.has(adapter)) {
          // the build graph (item 0409). Each edited document first as an unsaved text over the disk (document mode),
          // against the same document built from the disk by a fresh graph on a clean copy (entry mode); then the
          // edit written, the overlay dropped, and the project built (project mode) against the clean engine build
          const kept = graphs.get(adapter)!
          const was = process.env.TERM_CACHE_HOME
          process.env.TERM_CACHE_HOME = kept.home
          const documents = documentsOf(changes).filter(change => !change.text.startsWith('mark draft'))
          const one = verdict.get(adapter)!
          let built: { problems: unknown[]; built: number; reused: number }
          // the units the document requests built: the project request reuses them, so the edit's units built are both
          let documentBuilt = 0
          try {
            if (documents.length > 0) {
              for (const change of documents) port!.setOverlay(kept.graph, path.join(root, change.rel), change.text)
              const got: Diag[] = []
              for (const change of documents) {
                const answered = port!.buildRequest(kept.graph, ask('document', path.join(root, change.rel)), kept.store)
                got.push(...documentLines(root, change.rel, answered.answer!))
                documentBuilt += ((answered.answer as { result?: { built?: unknown[] } }).result?.built ?? []).length
              }
              const docRoot = copySources(truth, fresher('clean-doc'))
              const ran = spawnSync(process.execPath, [...process.execArgv, process.argv[1]!, '--clean-doc', docRoot, JSON.stringify(documents.map(change => change.rel))], {
                cwd: TERM,
                env: { ...process.env, TERM_CACHE_HOME: fresher('clean-doc-home') },
                encoding: 'utf8',
                maxBuffer: 1 << 28,
              })
              const line = ran.stdout.split('\n').find(text => text.startsWith('{"child"'))
              if (!line) throw new Error(`edit-replay-callers: the clean document child answered nothing\n${ran.stderr.slice(-2000)}`)
              one.builds++
              const apart = differences({ diags: got, artifacts: new Map() }, { diags: (JSON.parse(line) as { child: Diag[] }).child, artifacts: new Map() })
              if (apart.length > 0) {
                one.differ++
                failed = true
                console.log(`  DIFFER seed ${seed}, edit ${n} (${said}), adapter ${adapter}, unsaved documents:`)
                for (const text of apart.slice(0, 4)) console.log(`    ${text}`)
              } else if (args.includes('--verbose')) {
                console.log(`  same: seed ${seed}, edit ${n} (${said}), ${adapter} unsaved, ${documents.length} documents, ${got.length} lines`)
              }
            }
            for (const change of changes) apply(root, change)
            for (const change of documents) port!.dropOverlay(kept.graph, path.join(root, change.rel))
            const answered = port!.buildRequest(kept.graph, ask('project'), kept.store)
            built = answered.build!
          } finally {
            process.env.TERM_CACHE_HOME = was
          }
          answer = { diags: problemsOf(root, built.problems as never), artifacts: artifacts(root) }
          reference = cleanTs!
          // the units built must be the kept session's, when it runs: one engine, two holders of its state. The units
          // the document requests built count, since the project request then reuses them; the units reused differ by
          // those, and under a cap of one by the memo, so they are not compared
          if (sessionCounts !== undefined) {
            answer.diags = [...answer.diags, `units ${built.built + documentBuilt} built`]
            reference = { ...reference, diags: [...reference.diags, `units ${sessionCounts.split(',')[0]!}`] }
          }
        } else if (adapter === 'graph-fresh') {
          // a new graph in a new process (item 0410): it starts from the snapshot the last one wrote
          const ran = spawnSync(process.execPath, [...process.execArgv, process.argv[1]!, '--graph-child', root], {
            cwd: TERM,
            env: { ...process.env, TERM_CACHE_HOME: homes.get(adapter)! },
            encoding: 'utf8',
            maxBuffer: 1 << 28,
          })
          const line = ran.stdout.split('\n').find(one => one.startsWith('{"child"'))
          if (!line) throw new Error(`edit-replay-callers: the graph child answered nothing\n${ran.stderr.slice(-2000)}`)
          answer = { diags: (JSON.parse(line) as { child: Diag[] }).child, artifacts: artifacts(root) }
          reference = cleanTs!
        } else if (adapter === 'server') {
          // each edited document's diagnostics, as an unsaved change and then saved, against the clean build's
          // problems in that file; every other document is left to the builds above
          const looked = await server!.look(changes)
          const documents = new Set(looked.map(one => one.rel))
          // in order, document by document (item 0468): each document's diagnostics as the clean build ordered them
          const wanted = (diags: Diag[]): Diag[] => looked.flatMap(l => serverForm(diags.filter(d => fileOf(d) === l.rel)))
          const one = verdict.get(adapter)!
          for (const [phase, diags] of [['unsaved', looked.flatMap(l => l.unsaved)], ['saved', looked.flatMap(l => l.saved)]] as const) {
            one.builds++
            // `--break server-order`: the server's answer reversed, which only an in-order compare can see
            const given = breaking === 'server-order' ? [...diags].reverse() : diags
            const apart = differences({ diags: given, artifacts: new Map() }, { diags: wanted(clean.diags), artifacts: new Map() })
            if (apart.length > 0) {
              one.differ++
              failed = true
              console.log(`  DIFFER seed ${seed}, edit ${n} (${said}), adapter server, ${phase}:`)
              for (const line of apart.slice(0, 4)) console.log(`    ${line}`)
            } else if (args.includes('--verbose')) {
              console.log(`  same: seed ${seed}, edit ${n} (${said}), server ${phase}, ${documents.size} documents, ${diags.length} diagnostics`)
            }
          }
          if (n > 0) one.edits++
          continue
        } else if (adapter === 'rust') {
          // each edited document emitted as a Rust program, one file per module (`--emit rust --units`), by its kept
          // store, against the same emitted by a fresh copy on an empty store
          // an edit with no edited document emits the project's entry, so every edit compares some emitted Rust (0468)
          const edited = documentsOf(changes).filter(change => !change.text.startsWith('mark draft')).map(change => change.rel)
          const rels = edited.length > 0 ? edited : [projectEntry(truth)]
          const got: Diag[] = []
          const want: Diag[] = []
          for (const rel of rels) {
            const ours = emitUnits(root, rel, homes.get(adapter)!, `rust-${n}`)
            got.push(...ours)
            // an emission that answered 0 and wrote no file compared nothing: a difference, never a pass
            if (ours[0] === `${rel} exit 0` && !ours.some(line => line.startsWith(`${rel} file `))) got.push(`${rel} wrote no Rust`)
            if (args.includes('--verbose')) console.log(`  rust: ${rel}, ${ours.filter(line => line.startsWith(`${rel} file `)).length} files emitted`)
          }
          // the clean side at the SAME path (a native unit's file name holds the project's folder name and a hash of its
          // path, u_<folder>_code_<module>_<hash>.rs, so a copy elsewhere names every file apart), as a FRESH copy of the
          // truth on an empty home: the kept copy, its .base among it, is moved aside meanwhile and put back after
          const kept = path.join(fresher('rust-kept'), 'copy')
          renameSync(root, kept)
          try {
            copySources(truth, root)
            const home = fresher('clean-rust-home')
            for (const rel of rels) want.push(...emitUnits(root, rel, home, `clean-${n}`))
          } finally {
            renameSync(root, path.join(fresher('rust-clean-done'), 'copy'))
            renameSync(kept, root)
          }
          answer = { diags: got, artifacts: new Map() }
          reference = { diags: want, artifacts: new Map() }
        } else if (adapter === 'daemon') {
          // each edited document asked of the dev daemon (`POST /analyze`), against the clean build's problems in it
          const documents = documentsOf(changes)
          const got: Diag[] = []
          for (const change of documents) {
            const asked = await fetch(`http://127.0.0.1:${daemon!.port}/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: change.rel, text: change.text }) })
            const body = (await asked.json()) as { diagnostics: { severity?: string; name?: string; message?: string; hint?: string; file?: string; span?: { file?: string; start?: { line: number; column: number } } }[] }
            for (const d of body.diagnostics) {
              // a diagnostic's own file is `file`; a loaded module's carries no span file. Another file's error is the
              // build's too (the entry fails on it), compared where that file is; another file's WARNING is never the
              // document's, and the build reports none: a difference (item 0424)
              const where = d.file ?? d.span?.file
              if (where && path.relative(root, where) !== change.rel) {
                if (d.severity === 'warning') got.push(`foreign warning ${d.name} of ${path.relative(root, where)} answered for ${change.rel}`)
                continue
              }
              // the daemon answers raw spans, counted from 0; the build prints them from 1
              got.push(`${d.severity === 'warning' ? 'warning' : d.severity === 'info' ? 'info' : 'error'}|${d.name}|${(d.span?.start?.line ?? -1) + 1}:${(d.span?.start?.column ?? -1) + 1}|${d.message}${d.hint ? ` (${d.hint})` : ''}${where ? '' : ' [no file]'}`)
            }
          }
          // in order, document by document (item 0468), as the server's
          answer = { diags: got, artifacts: new Map() }
          reference = { diags: documents.flatMap(change => serverForm(clean.diags.filter(d => fileOf(d) === change.rel))), artifacts: new Map() }
        } else if (adapter === 'test') {
          // term test (work/testing/test-command.tree, one build graph a run) on its copy, its store kept for the
          // sequence, against the same on a clean copy and an empty store: every file's step and counts, every problem
          answer = { diags: testRun(root, homes.get(adapter)!), artifacts: new Map() }
          reference = { diags: testRun(copySources(truth, fresher('clean-test')), fresher('clean-test-home')), artifacts: new Map() }
        } else if (adapter === 'boot') {
          // term boot (work/boot/boot-running.tree) in this process, its one build graph kept across the sequence as the
          // dev loop keeps it, booting the deck's console into a fresh --out folder each edit, against a clean boot of
          // the same file in a process of its own: every file of the bundle, and whether it wrote one
          const rel = bootEntry(truth)
          const out = path.join(fresher('boot-out'), 'out')
          await bootHere(booter!, root, homes.get(adapter)!, rel, out)
          answer = { diags: [`bundle ${existsSync(path.join(out, 'run.mjs'))}`], artifacts: outFiles(out, root) }
          const cleanRoot = copySources(truth, fresher('clean-boot'))
          const cleanOut = path.join(fresher('clean-boot-out'), 'out')
          bootClean(cleanRoot, fresher('clean-boot-home'), rel, cleanOut)
          reference = { diags: [`bundle ${existsSync(path.join(cleanOut, 'run.mjs'))}`], artifacts: outFiles(cleanOut, cleanRoot) }
          if (args.includes('--verbose')) {
            const units = booter!.readLastBootUnits()
            console.log(`  boot: ${rel}, ${units.built} built, ${units.reused} reused`)
          }
        } else if (adapter === 'watch') {
          // the first build always comes; an edit that changed some file's text must bring one, and one that did not is
          // compared as it stands after the quiet wait
          const wanted = n === 0 || changed
          const settled = await watch!.settle(wanted)
          // host/roll.json among them: the watch writes it after each build that did not fail, as term make does (0425)
          answer = { diags: settled.diags, artifacts: artifacts(root) }
          // a watch that never rebuilt compares whatever is on disk, which after a comment, a blank line or a role edit
          // is the clean build's already: no rebuild after a change of text is a difference (item 0468)
          if (wanted && !settled.rebuilt) answer.diags = [...answer.diags, `no watch rebuild after ${said}`]
          if (n === 0 && breaking === 'watch-stop') watch!.stop()
        } else {
          const line = adapter === 'pool' && breaking !== 'pool-off' ? pooled : LINE
          let late = ''
          if (racy && adapter === 'fresh') {
            // the racy edit (decision 077 section 10): fresh builds the state before it, its own previous build, then
            // the same-size edit is written within 1 s of that build's end, then fresh builds again (item 0468)
            const before = sizesOf(root, changes)
            cli(LINE, root, homes.get(adapter)!)
            const ended = Date.now()
            if (breaking === 'racy-late') await new Promise(done => setTimeout(done, 1500))
            for (const change of changes) apply(root, change)
            const gap = Date.now() - ended
            if (gap >= 1000) late = `racy edit written ${gap} ms after the build, not within 1 s`
            else if (sizesOf(root, changes) !== before) late = 'racy edit changed a size'
          }
          const ran = cli(line, root, homes.get(adapter)!)
          answer = { diags: ran.diags, artifacts: artifacts(root) }
          if (ran.pool) verdict.get(adapter)!.pools++
          // the exit as a diagnostic line, so a build that stops where the clean one did not is a difference
          answer.diags = [...answer.diags, `exit ${ran.exit}`]
          // the pool adapter's build must have gone through the pool, or it tested the probe's path twice (item 0468)
          if (adapter === 'pool' && !ran.pool) answer.diags = [...answer.diags, 'the pool did not run']
          if (late) answer.diags = [...answer.diags, late]
          reference = { ...clean, diags: [...clean.diags, `exit ${cleanCli.exit}`] }
        }

        const one = verdict.get(adapter)!
        one.builds++
        if (n > 0) one.edits++
        const apart = differences(answer, reference)

        if (apart.length > 0) {
          one.differ++
          failed = true
          console.log(`  DIFFER seed ${seed}, edit ${n} (${said}), adapter ${adapter}:`)
          for (const line of apart.slice(0, 4)) console.log(`    ${line}`)
        } else if (args.includes('--verbose')) {
          console.log(`  same: seed ${seed}, edit ${n} (${said}), ${adapter}`)
        }
      }
    }

    watch?.stop()
    daemon?.close()

    if (lineStamp() !== lineAtStart) {
      failed = true
      unmeasured.push(seed)
      console.log(`  seed ${seed} NOT MEASURED: host/line.js moved during the seed (another make:line landed), run it again`)
    }
  }

  console.log('')
  for (const [adapter, one] of verdict) {
    console.log(`${adapter}: ${one.edits} edits, ${one.builds} builds compared, ${one.differ} differ${adapter === 'pool' ? `, the pool ran ${one.pools} of ${one.builds} builds` : ''}`)
  }
  const total = [...verdict.values()].reduce((a, b) => a + b.builds, 0)
  const differ = [...verdict.values()].reduce((a, b) => a + b.differ, 0)
  if (unmeasured.length > 0) console.log(`\nseeds not measured (the compiler moved): ${unmeasured.join(' ')}`)
  console.log(`\nedit-replay-callers: ${total - differ} pass, ${differ + (failed && differ === 0 ? 1 : 0)} fail`)
  process.exit(failed ? 1 : 0)
}

// no top-level await: task/term runs as CommonJS under tsx
void (args[0] === '--clean-child' ? cleanChild(args[1]!) : args[0] === '--clean-doc' ? cleanDocChild(args[1]!, JSON.parse(args[2]!) as string[]) : args[0] === '--graph-child' ? graphChild(args[1]!) : replay()).catch(problem => {
  console.error(problem)
  process.exit(2)
})
