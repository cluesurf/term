// port-build --units on a built tree (item term-self-host-001-1343, spec-1339 section 6): THE FAST PATH and a sound
// --verify. Run after make:line has built every port as units, from the Term root:
//   node node_modules/tsx/dist/cli.mjs test/call/port-build-units.ts
// 1. port-build --units again takes the fast path: 0 built, the engine never loaded, under LIMIT seconds (left out
//    with --verify-only)
// 2. --verify reads every entry current
// 3. --verify of a copy of the manifest where one unit was built against another interface of a unit it imports
//    reads that unit's entries stale, by the imports check
// 4. --verify of a copy where one unit's source hash differs reads its entries stale
// 6. every file under host/unit/ and the decks' host/port/ is one the manifest names (no shim, run entry, unit or temp
//    file of a shelved or deleted port left, item 1370)
// Bounded: one fast port-build, three compiler-free verifies and one walk. Exit 1 on any failure. Writes only
// tmp/port-build-units/
//
// `--bind [<file>#<name>]` (default deck/base/code/float.tree#truncate) runs ONLY step 5, spec-1339 section 4's bind
// case (1343 (d), item 1364): a bind's text is inlined at each use, so a change to it must reach every unit that
// inlines it. Its `case node` text gets its first parameter wrapped, `Math.trunc($value)` to `Math.trunc(($value))`,
// the bind found by its own `bind <name>` line (1343's (d) replaced the file's FIRST `Math.trunc($value)`, which is
// to-number's, and read truncate's inliners as stale: T-1364). Then port-build --units --explain, and:
//   - every unit whose module loads the bind's module and finds the name, and whose file inlined it, holds MORE of the
//     wrapped form than before (no stale replay)
//   - the files that changed are exactly the units holding more of it: no shim and no other unit moved
//   - the edit undone and port-build --units again, every unit and shim is back to its bytes before
// THE PRIVATE TREE (item term-self-host-001-1369): step 5 never edits the tree it was started in. The queue runs five
// checks at once in one trial tree, and an edit of deck/base/code/float.tree there made a --verify beside it read 317
// stale, and a halt (SIGTERM, then SIGKILL) left it edited. So step 5 first makes its own copy of the tree under
// $TMPDIR (an APFS clone, `cp -c`, no bytes copied: tmp/ and .git/ left out, of .base/ only port-build's manifest and
// units store), re-points the copy's symlinks that name this tree, and does every edit and build in the copy. A kill
// at any point leaves the started tree byte for byte as it was: what is left is a folder in $TMPDIR, which the queue
// removes with the check's TMPDIR. Run alone, the copy is removed at the end.
// Costs the copy (27 s on a loaded M3, l1368a) and two warm port-build runs (15 s to 67 s on the M3, l1364a, l1368a). It FAILS with
// the bind's text out of the engine's keys (tmp/self-host/1364/mutate-stage0.ts: 0 of 4 inliners took the text, l1364b)
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'

const STARTED = process.cwd()
// the tree every step reads and builds: the started tree, or under --bind its private copy (bindCheck sets it)
let ROOT = STARTED
const TSX = (): string => join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const MANIFEST = (): string => join(ROOT, '.base', '@term', 'code', 'port-build.json')
const SCRATCH = join(STARTED, 'tmp', 'port-build-units')
const LIMIT = 30
let failures = 0
// the environment of every port-build this test starts. Under --bind: the copy's stdlib, and no line lock token of the
// started tree's (the copy takes its own lock)
let childEnv: NodeJS.ProcessEnv = process.env

const run = (args: string[]): { code: number; out: string; seconds: number } => {
  const started = Date.now()
  const done = spawnSync('node', [TSX(), 'task/port-build.ts', ...args], { cwd: ROOT, env: childEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

  return { code: done.status ?? 1, out: `${done.stdout}${done.stderr}`, seconds: (Date.now() - started) / 1000 }
}
const expect = (label: string, holds: boolean, detail: string): void => {
  console.log(`${holds ? 'ok  ' : 'FAIL'} ${label}  (${detail})`)
  failures += holds ? 0 : 1
}
const last = (out: string): string => out.trim().split('\n').slice(-2).join(' / ')

type Manifest = { schema: number; units: Record<string, { sources: Record<string, string>; interface: string; imports: Record<string, string> }> }

// ---- step 5, `--bind` ----

const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

// every unit file and every entry shim, relative to the root, to its hash
function outputs(): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string): void => {
    if (!existsSync(dir)) {
      return
    }

    for (const one of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, one.name)

      if (one.isDirectory()) {
        walk(path)
      } else if (one.name.endsWith('.ts')) {
        out.set(relative(ROOT, path), sha(readFileSync(path)))
      }
    }
  }

  walk(join(ROOT, 'host', 'unit'))

  for (const deck of readdirSync(join(ROOT, 'deck'))) {
    walk(join(ROOT, 'deck', deck, 'host', 'port'))
  }

  return out
}

// how many times `needle` stands in a text
const countOf = (text: string, needle: string): number => text.split(needle).length - 1

// the bind's `case node` text line, and the line with its first parameter wrapped. Undefined when the file has no
// `bind <name>` at the top level, or that bind no node case with a `$` parameter
function bindEdit(text: string, name: string): { at: number; before: string; after: string; prefix: string } | undefined {
  const lines = text.split('\n')
  const head = lines.indexOf(`bind ${name}`)

  if (head < 0 || lines.indexOf(`bind ${name}`, head + 1) >= 0) {
    return undefined
  }

  for (let at = head + 1; at < lines.length && (lines[at] === '' || lines[at]!.startsWith(' ')); at++) {
    if (lines[at] !== '  case node') {
      continue
    }

    const line = lines[at + 1] ?? ''
    const found = /^ {4}text <(.*)>$/.exec(line)
    const parameter = found ? /\$[A-Za-z_][\w-]*/.exec(found[1]!) : null

    if (!found || !parameter) {
      return undefined
    }

    const prefix = found[1]!.slice(0, parameter.index)
    const after = `    text <${prefix}(${parameter[0]})${found[1]!.slice(parameter.index + parameter[0].length)}>`

    return prefix === '' ? undefined : { at: at + 1, before: line, after, prefix }
  }

  return undefined
}

// the specifiers a module writes for `file`: its package path `@term/<deck>/<path>`, and a relative one from `from`
function namesFile(spec: string, from: string, file: string): boolean {
  const packaged = /^deck\/([^/]+)\/code\/(.+)\.tree$/.exec(file)

  if (packaged && spec === `@term/${packaged[1]}/${packaged[2]}`) {
    return true
  }

  if (!spec.startsWith('.')) {
    return false
  }

  const target = resolve(ROOT, dirname(from), spec)

  return [`${target}.tree`, join(target, 'base.tree')].includes(join(ROOT, file))
}

// whether a module's text loads `file` and finds `name` from it (a `load` line, then its indented `find` lines)
function findsFrom(text: string, from: string, file: string, name: string): boolean {
  const lines = text.split('\n')

  for (let at = 0; at < lines.length; at++) {
    const load = /^load (\S+)$/.exec(lines[at]!)

    if (!load || !namesFile(load[1]!, from, file)) {
      continue
    }

    for (let next = at + 1; next < lines.length && lines[next]!.startsWith(' '); next++) {
      if (new RegExp(`^ +find ${name}(,|$)`).test(lines[next]!)) {
        return true
      }
    }
  }

  return false
}

function bindCheck(given: string): void {
  const [file, name] = given.split('#') as [string, string | undefined]

  if (!name || !existsSync(join(ROOT, file))) {
    expect('bind named', false, `--bind ${given}: want <file>#<name> of a file under the root`)
    return
  }

  const original = readFileSync(join(ROOT, file), 'utf8')
  const edit = bindEdit(original, name)

  if (!edit) {
    expect('bind found', false, `no top-level bind ${name} with a node case text and a $ parameter in ${file}`)
    return
  }

  const manifest = JSON.parse(readFileSync(MANIFEST(), 'utf8')) as Manifest
  const wrapped = `${edit.prefix}(`
  const unitFile = (slug: string): string => join(ROOT, 'host', 'unit', `${slug}.ts`)
  const wrappedBefore = new Map<string, number>()

  for (const slug of Object.keys(manifest.units)) {
    if (existsSync(unitFile(slug))) {
      wrappedBefore.set(slug, countOf(readFileSync(unitFile(slug), 'utf8'), wrapped))
    }
  }

  // the units whose own module finds the bind and whose file holds its text: each inlines it
  const inliners = Object.entries(manifest.units)
    .filter(([slug, row]) => {
      const module = Object.keys(row.sources)[0]

      if (!module || module === file || !existsSync(join(ROOT, module)) || !existsSync(unitFile(slug))) {
        return false
      }

      return findsFrom(readFileSync(join(ROOT, module), 'utf8'), module, file, name) && readFileSync(unitFile(slug), 'utf8').includes(edit.prefix)
    })
    .map(([slug]) => slug)
    .sort()

  expect('bind inliners', inliners.length > 0, `${inliners.length} units find ${name} from ${file} and inline it: ${inliners.join(', ')}`)

  const before = outputs()
  const keptDir = join(SCRATCH, 'bind')

  mkdirSync(keptDir, { recursive: true })

  const kept = join(keptDir, `${file.split('/').join('_')}.${Date.now()}.kept`)

  if (existsSync(kept)) {
    expect('bind copy', false, `${kept} exists, refusing to write over it`)
    return
  }

  writeFileSync(kept, original)

  const lines = original.split('\n')

  lines[edit.at] = edit.after

  let built: string[] = []
  let changed: string[] = []

  try {
    writeFileSync(join(ROOT, file), lines.join('\n'))

    const moved = run(['--units', '--explain'])

    // an edited source can never take the fast path (in the private tree it did, while the manifest named the started
    // tree's files)
    expect('bind build', moved.code === 0 && !/: fast path, \d+ entries/.test(moved.out), `exit ${moved.code}, ${moved.seconds.toFixed(1)} s, ${moved.out.split('\n').find(line => /units store/.test(line))?.trim() ?? 'no units store line'}, ${last(moved.out)}`)
    built = [...new Set(moved.out.split('\n').map(line => /^ {2}unit built (\S+)/.exec(line)?.[1]).filter((one): one is string => one !== undefined))]
      .map(one => relative(ROOT, one.split('+')[0]!))
      .sort()

    const after = outputs()

    changed = [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path)).sort()
  } finally {
    writeFileSync(join(ROOT, file), original)
  }

  const rose = [...wrappedBefore.keys()]
    .filter(slug => existsSync(unitFile(slug)) && countOf(readFileSync(unitFile(slug), 'utf8'), wrapped) > wrappedBefore.get(slug)!)
    .map(slug => `host/unit/${slug}.ts`)
    .sort()
  const stale = inliners.filter(slug => !rose.includes(`host/unit/${slug}.ts`))

  // THE BIND CASE: the text reached every unit that inlines it, and moved nothing else
  expect('bind reaches every inliner', stale.length === 0, `${inliners.length - stale.length} of ${inliners.length} inliners hold the new text${stale.length > 0 ? `, STALE: ${stale.join(', ')}` : ''}`)
  expect(
    'bind moves only the inliners',
    changed.length === rose.length && changed.every(path => rose.includes(path)),
    `${changed.length} files changed, ${rose.length} units hold more ${JSON.stringify(wrapped)}; engine built ${built.length} distinct units${changed.filter(path => !rose.includes(path)).length > 0 ? `, other: ${changed.filter(path => !rose.includes(path)).slice(0, 5).join(', ')}` : ''}`,
  )
  console.log(`  bind changed: ${changed.join(' ')}`)
  console.log(`  bind engine built: ${built.join(' ')}`)

  const back = run(['--units'])
  const again = outputs()
  const differ = [...new Set([...before.keys(), ...again.keys()])].filter(path => before.get(path) !== again.get(path))

  expect('bind undone', back.code === 0 && differ.length === 0, `exit ${back.code}, ${back.seconds.toFixed(1)} s, ${differ.length} of ${before.size} files differ from before${differ.length > 0 ? `: ${differ.slice(0, 5).join(', ')}` : ''}`)
}

// THE PRIVATE TREE: a copy of `from` in a new folder under $TMPDIR, by APFS clone. Every top-level entry but tmp/ and
// .git/; of .base/, only port-build's manifest and its units store (a line lock folder cloned while another process
// holds it would make the copy's port-build wait on a holder that never frees it). Then every symlink in the copy that
// names `from` names the same place in the copy (node_modules/ left alone: pnpm's links there are relative), and
// a check that none is left. Answers the copy's root and the seconds it took, or why it could not
function privateTree(from: string): { root: string; seconds: number } | { why: string } {
  const started = Date.now()
  // the real path: port-build's root is its process.cwd(), which macOS answers through /private, and a TERM_STDLIB
  // spelled through the /var link would not start with it
  const base = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'port-build-units-bind-')))
  const root = join(base, 'tree')

  // a copy inside the tree it copies would be in its own walks, and its paths would start with the tree's
  if (root.startsWith(`${from}${sep}`)) {
    return { why: `TMPDIR ${base} is inside the tree ${from}: set TMPDIR outside it` }
  }

  const clone = (source: string, target: string): string | undefined => {
    mkdirSync(dirname(target), { recursive: true })
    const done = spawnSync('cp', ['-c', '-R', '-p', source, target], { encoding: 'utf8' })

    return done.status === 0 ? undefined : `cp -c ${relative(from, source)}: ${(done.stderr || done.error?.message || `exit ${done.status}`).trim()}`
  }

  mkdirSync(root)

  for (const entry of readdirSync(from)) {
    if (entry === 'tmp' || entry === '.git' || entry === '.base') {
      continue
    }

    const failed = clone(join(from, entry), join(root, entry))

    if (failed) {
      return { why: failed }
    }
  }

  for (const kept of ['port-build.json', 'port-unit']) {
    const source = join(from, '.base', '@term', 'code', kept)

    if (existsSync(source)) {
      const failed = clone(source, join(root, '.base', '@term', 'code', kept))

      if (failed) {
        return { why: failed }
      }
    }
  }

  // the manifest's table names every file it observed by its absolute path, so the copy's would key its fast path on
  // the STARTED tree's files: an edit in the copy took the fast path and built nothing (l1368a, 19:45Z). Every path
  // under the started tree is said under the copy instead, by prefix, as the queue's carry does (T-1096b)
  const copied = join(root, '.base', '@term', 'code', 'port-build.json')

  if (existsSync(copied)) {
    const text = readFileSync(copied, 'utf8')
    const rooted = text.split(JSON.stringify(`${from}${sep}`).slice(1, -1)).join(JSON.stringify(`${root}${sep}`).slice(1, -1))

    writeFileSync(copied, rooted)

    if (rooted.includes(JSON.stringify(`${from}${sep}`).slice(1, -1))) {
      return { why: `the copy's manifest still names ${from}` }
    }
  }

  let moved = 0
  const left: string[] = []
  const walk = (dir: string): void => {
    for (const one of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, one.name)

      if (one.isSymbolicLink()) {
        const target = readlinkSync(path)

        if (target === from || target.startsWith(`${from}${sep}`)) {
          unlinkSync(path)
          symlinkSync(join(root, relative(from, target)), path)
          moved++
        }
      } else if (one.isDirectory() && !(dir === root && one.name === 'node_modules')) {
        walk(path)
      }
    }
  }

  walk(root)

  // the check: no symlink outside node_modules/ names the started tree
  const recheck = (dir: string): void => {
    for (const one of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, one.name)

      if (one.isSymbolicLink()) {
        const target = readlinkSync(path)

        if (target === from || target.startsWith(`${from}${sep}`)) {
          left.push(relative(root, path))
        }
      } else if (one.isDirectory() && !(dir === root && one.name === 'node_modules')) {
        recheck(path)
      }
    }
  }

  recheck(root)

  if (left.length > 0) {
    return { why: `${left.length} symlinks in the copy still name the started tree, as ${left.slice(0, 3).join(', ')}` }
  }

  console.log(`  private tree ${root}: cloned and ${moved} symlinks re-pointed in ${((Date.now() - started) / 1000).toFixed(1)} s`)
  return { root, seconds: (Date.now() - started) / 1000 }
}

const bindAt = process.argv.indexOf('--bind')

if (bindAt >= 0) {
  const given = process.argv[bindAt + 1]
  const copy = privateTree(STARTED)

  if ('why' in copy) {
    expect('private tree', false, copy.why)
  } else {
    ROOT = copy.root
    // TERM_STDLIB and TERM_ROOT name the copy where they named anything (port-build's print reads each as `<root>/...`,
    // so the copy's print is the started tree's and its units store is warm). One that was unset stays unset: set, it
    // would be a new variable in the print, a cold namespace
    childEnv = { ...process.env, TERM_STDLIB: join(ROOT, 'deck', 'base') }

    if (process.env.TERM_ROOT !== undefined) {
      childEnv.TERM_ROOT = ROOT
    }

    delete childEnv.TERM_LINE_LOCK

    try {
      bindCheck(given !== undefined && !given.startsWith('--') ? given : 'deck/base/code/float.tree#truncate')
    } finally {
      // the copy is this run's own scratch; TERM_BIND_KEEP=1 keeps it to read
      if (process.env.TERM_BIND_KEEP !== '1') {
        rmSync(dirname(copy.root), { recursive: true, force: true })
      }
    }
  }

  console.log(`port-build-units --bind: ${failures === 0 ? 'PASS' : `FAIL ${failures}`}`)
  process.exit(failures === 0 ? 0 : 1)
}

// `--verify-only`: steps 2 to 4, which compile nothing (a run of an altered port-build moves the fingerprint)
if (!process.argv.includes('--verify-only')) {
  const fast = run(['--units'])

  expect(
    'fast path',
    fast.code === 0 && /fast path, \d+ entries/.test(fast.out) && /term port-build: 0 built/.test(fast.out) && fast.seconds < LIMIT,
    `exit ${fast.code}, ${fast.seconds.toFixed(1)} s, ${last(fast.out)}`,
  )
}

const verify = run(['--verify'])

expect('verify current', verify.code === 0 && / 0 stale/.test(verify.out), `exit ${verify.code}, ${last(verify.out)}`)

const manifest = JSON.parse(readFileSync(MANIFEST(), 'utf8')) as Manifest

expect('schema 3', manifest.schema === 3, `schema ${manifest.schema}`)
mkdirSync(SCRATCH, { recursive: true })

// a unit that imports another unit the manifest records, the first by slug, so a rerun alters the same row
const importer = Object.keys(manifest.units)
  .sort()
  .find(slug => Object.keys(manifest.units[slug]!.imports).some(dep => manifest.units[dep] !== undefined))

if (importer === undefined) {
  expect('a unit that imports another', false, 'none in the manifest')
} else {
  const dep = Object.keys(manifest.units[importer]!.imports)
    .sort()
    .find(one => manifest.units[one] !== undefined)!
  const faced = structuredClone(manifest)

  faced.units[importer]!.imports[dep] = `moved-${faced.units[importer]!.imports[dep]}`

  const facedPath = join(SCRATCH, 'interface.json')

  writeFileSync(facedPath, JSON.stringify(faced))

  const one = run(['--verify', '--manifest', facedPath])
  const named = one.out.split('\n').filter(line => line.includes(`was built against another interface of host/unit/${dep}.ts`)).length

  expect('imports check', one.code === 1 && named > 0, `exit ${one.code}, ${named} entries name ${importer} built against another interface of ${dep}, ${last(one.out)}`)

  const sourced = structuredClone(manifest)
  const file = Object.keys(sourced.units[dep]!.sources)[0]!

  sourced.units[dep]!.sources[file] = `moved-${sourced.units[dep]!.sources[file]}`

  const sourcedPath = join(SCRATCH, 'source.json')

  writeFileSync(sourcedPath, JSON.stringify(sourced))

  const two = run(['--verify', '--manifest', sourcedPath])
  const stale = two.out.split('\n').filter(line => line.includes(`${file} changed after host/unit/${dep}.ts was built`)).length

  expect('source check', two.code === 1 && stale > 0, `exit ${two.code}, ${stale} entries reach ${dep} with ${file} changed, ${last(two.out)}`)
}

// 6. NO OUTPUT WITHOUT A SOURCE (item term-self-host-001-1370, T-0425): every file under host/unit/ and under a deck's
// host/port/ is one the manifest names (a unit's file, a shim, a shim's -run.ts), so a shelved or deleted port left no
// shim, run entry, unit or temp file behind
{
  const named = new Set<string>()
  const shims = (manifest as Manifest & { shims?: Record<string, { run?: string }> }).shims ?? {}

  for (const slug of Object.keys(manifest.units)) {
    named.add(join('host', 'unit', `${slug}.ts`))
  }

  for (const [key, row] of Object.entries(shims)) {
    named.add(key)

    if (row.run !== undefined) {
      named.add(key.replace(/\.ts$/, '-run.ts'))
    }
  }

  const all: string[] = []
  const walk = (dir: string): void => {
    for (const one of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
      const path = join(dir, one.name)

      if (one.isDirectory()) {
        walk(path)
      } else {
        all.push(relative(ROOT, path))
      }
    }
  }

  walk(join(ROOT, 'host', 'unit'))

  for (const deck of readdirSync(join(ROOT, 'deck'))) {
    walk(join(ROOT, 'deck', deck, 'host', 'port'))
  }

  const stray = all.filter(path => !named.has(path)).sort()

  expect('no output without a source', stray.length === 0, `${all.length} files under host/unit and host/port, ${stray.length} the manifest does not name${stray.length > 0 ? `: ${stray.slice(0, 5).join(', ')}` : ''}`)
}

console.log(`port-build-units: ${failures === 0 ? 'PASS' : `FAIL ${failures}`}`)
process.exit(failures === 0 ? 0 : 1)
