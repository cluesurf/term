// The persisted build graph (decision 077 section 7, decision 079, item term-self-host-001-0410): a fresh process
// starts from the snapshot the last build wrote (work/build/build-graph.tree `load-snapshot`, `save-snapshot`), and the
// snapshot is ADVISORY: one that is corrupt, cut short, another compiler's, another root's or that finds a package's
// folder listed differently is ignored whole, so it costs time and never an answer. Each fresh build here is a new
// graph (a new session, as a new process has) over the same project, compared with a clean build of the same sources
// (a fresh copy, no snapshot): every artifact under host/ byte for byte and every problem.
//
// Cases: the snapshot is taken after a build and replays a no-op; corrupt, truncated, another compiler's, another
// root's and a package folder listed differently are each refused; an artifact touched or removed is written again; a
// racy edit (same size, same modification time, in the second the build ran) is seen; two writers at once leave a
// snapshot that is whole or ignored, never a wrong answer. Format 2 (decision 083, item term-self-host-001-0450): the
// written body decodes to the body the session holds, a problem's file text is read back from the disk and an entry
// whose file reads otherwise builds again, a format 1 file is refused, and only the newest three snapshots are kept.
// Run: npx tsx test/call/graph-snapshot.ts (GRAPH_MODULE=<emitted draft> runs a draft before it lands)

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tempDir } from '../temp'

type Port = {
  makeBuildGraph: (root: string, unitCap?: number) => { session: unknown }
  buildRequest: (graph: unknown, ask: Record<string, unknown>, store?: unknown) => { build?: { problems: { diagnostic: { name?: string; message?: string } }[]; built: number; reused: number; compiled: number } }
  loadSnapshot: (session: unknown, started: number) => boolean
  snapshotPath: (root: string) => string
  snapshotBody: (session: unknown, started: number) => { form: string; value?: Record<string, unknown> }
  decodedSnapshot: (root: string) => Record<string, unknown> | undefined
}

const loaded = await import(process.env.GRAPH_MODULE || '@term/call/code/work/build/build-graph')
const port = ((loaded as { default?: unknown }).default ?? loaded) as Port
const ask = { mode: 'project', file: '', platform: 'node', precomputed: undefined, explain: undefined }

// a writer of the two-writer case: one project request by a new graph, in a process of its own
if (process.argv[2] === '--child') {
  process.env.TERM_CACHE_HOME = process.argv[4]!
  port.buildRequest(port.makeBuildGraph(process.argv[3]!), ask)
  process.exit(0)
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

// a line no earlier run wrote, so the store a previous run filled holds none of this project's units
const fresh = `# run ${process.pid} at ${Date.now()}\n`
const root = realpathSync(tempDir('graph-snapshot-'))
const home = realpathSync(tempDir('graph-snapshot-home-'))
const cleanHome = realpathSync(tempDir('graph-snapshot-clean-home-'))

const helperText = (answer: number): string => `${fresh}load @term/base/text\n  find trim\n\ntask answer\n  take who, like text\n  like number\n  save said, trim(who)\n  back ${answer}\n`

mkdirSync(join(root, 'code'), { recursive: true })
writeFileSync(join(root, 'deck.tree'), 'deck @probe/snapshot\n  mark <0.0.1>\n')
writeFileSync(join(root, 'code', 'helper.tree'), helperText(31))
writeFileSync(join(root, 'code', 'base.tree'), `${fresh}load ./helper\n  find answer\n\ntask main\n  like number\n  back answer(<a>)\n`)
writeFileSync(join(root, 'code', 'other.tree'), `${fresh}load ./helper\n  find answer\n\ntask other\n  like number\n  back answer(<b>)\n`)

type Answer = { built: number; problems: string[]; artifacts: Map<string, string> }

function artifactsOf(at: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else out.set(relative(at, full), readFileSync(full, 'utf8').split(at).join('<root>'))
    }
  }
  walk(join(at, 'host'))
  return out
}

// one project request by a new graph over `at`, with `cacheHome` as the store
function build(at: string, cacheHome: string): Answer {
  const was = process.env.TERM_CACHE_HOME
  process.env.TERM_CACHE_HOME = cacheHome
  try {
    const answered = port.buildRequest(port.makeBuildGraph(at), ask).build!
    return {
      built: answered.built,
      problems: answered.problems.map(p => `${p.diagnostic.name}|${p.diagnostic.message}`),
      artifacts: artifactsOf(at),
    }
  } finally {
    process.env.TERM_CACHE_HOME = was
  }
}

// the same sources built clean: a fresh copy, no snapshot
function clean(): Answer {
  const copy = realpathSync(tempDir('graph-snapshot-clean-'))
  cpSync(join(root, 'deck.tree'), join(copy, 'deck.tree'))
  cpSync(join(root, 'code'), join(copy, 'code'), { recursive: true })
  const answer = build(copy, cleanHome)
  const renamed = new Map([...answer.artifacts].map(([file, text]) => [file, text.split(copy).join('<root>')]))
  return { ...answer, artifacts: renamed }
}

function same(a: Answer, b: Answer): string {
  if (a.problems.join('\n') !== b.problems.join('\n')) return `problems ${a.problems.length} vs ${b.problems.length}`
  for (const file of new Set([...a.artifacts.keys(), ...b.artifacts.keys()])) {
    if (a.artifacts.get(file) !== b.artifacts.get(file)) return `artifact ${file} ${a.artifacts.has(file) ? (b.artifacts.has(file) ? 'differs' : 'extra') : 'missing'}`
  }
  return ''
}

// whether a new session takes the snapshot as it stands
const takes = (): boolean => {
  const was = process.env.TERM_CACHE_HOME
  process.env.TERM_CACHE_HOME = home
  try {
    return port.loadSnapshot(port.makeBuildGraph(root).session, Date.now())
  } finally {
    process.env.TERM_CACHE_HOME = was
  }
}

const path = port.snapshotPath(root)
const sum = (body: string): string => createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 32)
const HEAD = '# term graph 2\n'

// a written body's path at an index: a path under the project's root is written relative to it
const pathAt = (body: Record<string, unknown>, key: string): string => {
  const spelled = (body.paths as string[])[Number(key)]!
  return spelled.startsWith('/') ? spelled : join(root, spelled)
}

// a value with its keys sorted, so two bodies compare field for field
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value as object).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]))
      : value

// the snapshot's body rewritten by `change`, with its sum made right again: only the check under test can refuse it
function rewrite(change: (body: Record<string, unknown>) => void): void {
  const text = readFileSync(path, 'utf8')
  const body = JSON.parse(text.slice(HEAD.length + 33)) as Record<string, unknown>
  change(body)
  const out = JSON.stringify(body)
  writeFileSync(path, `${HEAD}${sum(out)}\n${out}`)
}

// a build that writes the snapshot again, as it stands
const settle = (): Answer => build(root, home)

const first = settle()
ok('the first build builds', first.built > 0, `${first.built} built`)
ok('the first build is clean', same(first, clean()) === '', same(first, clean()))
ok('it writes a snapshot', existsSync(path), path)
ok('a new session takes it', takes())
const noop = settle()
ok('a no-op from the snapshot builds nothing and equals clean', noop.built === 0 && same(noop, clean()) === '', `${noop.built} built ${same(noop, clean())}`)

// corrupt: one character of the body changed, so its sum no longer holds
const whole = readFileSync(path, 'utf8')
const at = whole.length - 40
writeFileSync(path, `${whole.slice(0, at)}${whole[at] === 'x' ? 'y' : 'x'}${whole.slice(at + 1)}`)
ok('a corrupt snapshot is refused', !takes())
ok('a build over it equals clean', same(settle(), clean()) === '')
ok('and writes a whole one again', takes())

writeFileSync(path, whole.slice(0, Math.floor(whole.length / 2)))
ok('a truncated snapshot is refused', !takes())
writeFileSync(path, HEAD)
ok('a snapshot of its header alone is refused', !takes())
settle()

rewrite(body => (body.fingerprint = 'another compiler'))
ok('another compiler\'s snapshot is refused', !takes())
settle()
rewrite(body => (body.root = '/another/root'))
ok('another root\'s snapshot is refused', !takes())
settle()
rewrite(body => (body.env = `${body.env}\nTERM_OTHER=1`))
ok('another environment\'s snapshot is refused', !takes())
settle()

const folders = Object.keys(JSON.parse(readFileSync(path, 'utf8').slice(HEAD.length + 33)).folders as object)
ok('it records the folders of the packages it reaches', folders.length > 0, `${folders.length} folders`)
// a folder whose stamp moved is listed again: the same names keep the snapshot, other names refuse it
rewrite(body => {
  const listed = body.folders as Record<string, { stamp: string }>
  listed[Object.keys(listed)[0]!]!.stamp = 'moved since'
})
ok('a package folder touched but listed alike keeps the snapshot', takes())
rewrite(body => {
  const listed = body.folders as Record<string, { stamp: string; hash: string }>
  listed[Object.keys(listed)[0]!]!.stamp = 'moved since'
  listed[Object.keys(listed)[0]!]!.hash = 'listed otherwise'
})
ok('a package folder listed otherwise refuses the snapshot', !takes())
settle()
rewrite(body => {
  const decks = body.decks as Record<string, { stamp: string; hash: string }>
  const manifest = Object.keys(decks).find(at => pathAt(body, at).endsWith('deck.tree'))!
  decks[manifest]!.stamp = 'moved since'
  decks[manifest]!.hash = 'another manifest'
})
ok('a package manifest that moved refuses the snapshot', !takes())
settle()
ok('the snapshot is taken again after a build', takes())

// a file added, or a project setting moved, would start the session over at its first turn: the snapshot is refused
// (a session started over empties the walks term make's probe made, item 0410's roll.json difference)
const added = join(root, 'code', 'added.tree')
writeFileSync(added, `${fresh}task added\n  like number\n  back 1\n`)
ok('a file added refuses the snapshot', !takes())
const addedBuild = settle()
ok('a build with the file added equals clean', same(addedBuild, clean()) === '', same(addedBuild, clean()))
rmSync(added)
settle()
writeFileSync(join(root, 'deck.tree'), 'deck @probe/snapshot\n  mark <0.0.2>\n')
ok('a project setting moved refuses the snapshot', !takes())
settle()

// an artifact touched or removed: the snapshot still holds, and the entry standing behind it builds again
const unit = [...artifactsOf(root).keys()].find(file => file.includes('.unit'))!
writeFileSync(join(root, unit), '// touched\n')
ok('a touched artifact leaves the snapshot taken', takes())
const touched = settle()
ok('a touched artifact is written again, equal to clean', same(touched, clean()) === '', same(touched, clean()))
rmSync(join(root, unit))
const removed = settle()
ok('a removed artifact is written again, equal to clean', same(removed, clean()) === '', same(removed, clean()))

// THE RACY STAMP: an edit in the second of the build, the same size and the same modification time, inode kept. The file
// is written just before the build, so its time is the build's, and edited just after it with its stamp put back
const helper = join(root, 'code', 'helper.tree')
// a whole millisecond, so putting the time back is exact (a time read back from stat carries a fraction utimes rounds)
const tick = Math.floor(Date.now()) / 1000
writeFileSync(helper, helperText(31))
utimesSync(helper, tick, tick)
settle()
const before = statSync(helper)
writeFileSync(helper, helperText(32))
utimesSync(helper, tick, tick)
const after = statSync(helper)
ok('the racy edit keeps the stamp', after.size === before.size && after.mtimeMs === before.mtimeMs && after.ino === before.ino, `${before.size}:${before.mtimeMs} ${after.size}:${after.mtimeMs}`)
const racy = settle()
ok('a racy edit is built, equal to clean', racy.built > 0 && same(racy, clean()) === '', `${racy.built} built ${same(racy, clean())}`)

// TWO WRITERS AT ONCE: two processes build the same project after an edit, each writing its snapshot
writeFileSync(helper, helperText(33))
const child = (): Promise<number> =>
  new Promise(done => {
    const ran = spawn(process.execPath, [...process.execArgv, process.argv[1]!, '--child', root, home], { stdio: 'ignore', env: process.env })
    ran.on('exit', code => done(code ?? -1))
  })

const codes = await Promise.all([child(), child()])
ok('two writers both finish', codes.every(code => code === 0), codes.join(' '))
ok('two writers leave no temp file', readdirSync(join(path, '..')).every(name => !name.endsWith('.tmp')))
const raced = settle()
ok('a build after two writers equals clean', same(raced, clean()) === '', same(raced, clean()))
ok('and its snapshot is taken', takes())

// FORMAT 2 (decision 083). The body written decodes to the body the session holds, field for field
{
  const was = process.env.TERM_CACHE_HOME
  process.env.TERM_CACHE_HOME = home
  try {
    // a helper an hour old, so its stamp is older than any racy line: only its text can tell an edit
    const hour = Math.floor(Date.now() / 1000) - 3600
    writeFileSync(helper, helperText(35))
    utimesSync(helper, hour, hour)
    const graph = port.makeBuildGraph(root)
    port.buildRequest(graph, ask)
    const held = port.snapshotBody(graph.session, Date.now())
    const decoded = port.decodedSnapshot(root)
    const blank = (body: Record<string, unknown> | undefined) => body && { ...body, generation: 0, taken: 0, stable: '' }
    ok('the written body decodes to the session\'s', held.form === 'some' && JSON.stringify(canonical(blank(decoded))) === JSON.stringify(canonical(blank(held.value))))
    const raw = readFileSync(path, 'utf8')
    ok('the snapshot is format 2', raw.startsWith(HEAD))
    const written = JSON.parse(raw.slice(HEAD.length + 33)) as Record<string, unknown>
    ok('each path is written once', new Set(written.paths as string[]).size === (written.paths as string[]).length && !raw.slice(HEAD.length + 33).includes(`"${join(root, 'code', 'helper.tree')}"`))
    // the helper's unused binding is a warning, framed in its file: its text is the file's, read back from the disk
    const entries = (decoded?.entries ?? {}) as Record<string, { problems: { text?: string }[] }>
    const framed = entries[helper]?.problems ?? []
    ok('a problem\'s text is filled from the disk', framed.length > 0 && framed[0]!.text === readFileSync(helper, 'utf8') && !raw.includes('task answer'), `${framed.length} problems`)
  } finally {
    process.env.TERM_CACHE_HOME = was
  }
}
// the helper's text changed after the write with its stamp kept (same size, same time, inode kept): its problem's text
// reads otherwise, so its entry is not taken and builds again, equal to clean
{
  const before = statSync(helper)
  writeFileSync(helper, helperText(36))
  utimesSync(helper, before.atime, before.mtime)
  const after = statSync(helper)
  ok('the edit keeps the stamp', after.size === before.size && after.mtimeMs === before.mtimeMs && after.ino === before.ino)
  ok('the snapshot is still taken', takes())
  const changed = settle()
  ok('the entry whose file reads otherwise builds again, equal to clean', changed.built > 0 && same(changed, clean()) === '', `${changed.built} built ${same(changed, clean())}`)
}
// a format 1 file, whole and summed, is refused
{
  const text = readFileSync(path, 'utf8')
  writeFileSync(path, `# term graph 1\n${text.slice(HEAD.length)}`)
  ok('a format 1 snapshot is refused', !takes())
  settle()
}
// only the newest three snapshots of the project are kept
{
  const folder = join(path, '..')
  const old = [0, 1, 2, 3].map(n => join(folder, `old-${n}`))
  old.forEach((file, n) => {
    writeFileSync(file, 'old\n')
    const time = Math.floor(Date.now() / 1000) - 7200 + n * 60
    utimesSync(file, time, time)
  })
  writeFileSync(helper, helperText(37))
  settle()
  const left = readdirSync(folder).sort()
  const want = [path, old[2]!, old[3]!].map(file => relative(folder, file)).sort()
  ok('the newest three snapshots are kept', JSON.stringify(left) === JSON.stringify(want), left.join(' '))
}

console.log(`\ngraph-snapshot: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
