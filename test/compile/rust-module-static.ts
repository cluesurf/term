// E10 on Rust (decision 138 rule 4, amended by item 1124, term-self-host-001-1117): a top-level host that is a Sync
// record or `host` data tree, literal or computed, is one process-wide `static NAME: std::sync::LazyLock<T>`, built on
// its first read on any thread, never a `thread_local!` built once per thread. A module list a task writes stays
// `thread_local!` and keeps its writes. One program, compiled for node and for Rust:
//   - first: a literal record of a named form holding text and a list it owns (a plain `Vec` field)
//   - place: a `host` data tree with a nested tree
//   - made: a computed host, the result of a call, of the same form
//   - seen: a module list a task pushes onto, which must stay `thread_local!`
// Each is read in the entry and, for the three statics, again in a spawned thread. Rust must print what node does.
// Run: npx tsx test/compile/rust-module-static.ts

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { emitRust } from '@term/make/code/compile/rust'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

const text = `load @term/base/list
  find push
  find size

form spot
  link name, like text
  link size, like number
  link tags, like list, like text

host first, make(spot, bind(name, <a>), bind(size, 1), bind(tags, make(list)))

host place
  host name, <north>
  host size, 3
  host seat
    host note, <deep>
    host deep, 7

host made, make-spot(4)

host seen
  like list, like text
  make list

task make-spot
  take at, like number
  like spot
  save tags, make list
  push(tags, <m>)
  push(tags, <z>)
  back make(spot, bind(name, <made>), bind(size, at), bind(tags, tags))

task weigh
  take b, like spot
  like number
  back add(size(b/tags), b/size)

task note-seen
  take word, like text
  push(seen, word)

task read-sync
  take at, like number
  like text
  back <{first/name} {weigh(first)} {place/name} {place/size} {place/seat/note} {place/seat/deep} {made/name} {weigh(made)} {at}>

task read-seen
  take at, like number
  like text
  note-seen(<p>)
  note-seen(<q>)
  back <{size(seen)} {at}>
`

const file = '/gate/code/module-static.tree'
const leanOf = (f: string): boolean => f === file
const entries = ['read-sync', 'read-seen']

// node: the entry's reads, then the same again as the thread would make them, then the list after its writes
let want = ''
const node = compile({ file, text }, { resolve: withNativeEnv('node', stdlibResolver()!), leanOf, entryPoints: entries })
if (!node.ok) {
  ok('the program builds for node', false, node.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const dir = mkdtempSync(join(tmpdir(), 'term-rust-module-static-'))
  const out = join(dir, 'module.mjs')
  writeFileSync(out, transformSync(node.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(out).href)) as Record<string, (n: number) => string>
  want = [mod.readSync!(1), mod.readSync!(2), mod.readSeen!(1), mod.readSeen!(2)].join('|')
  ok('node answers', want === 'a 1 north 3 deep 7 made 6 1|a 1 north 3 deep 7 made 6 2|2 1|4 2', want)
}

const built = compile({ file, text }, { resolve: withNativeEnv('rust', stdlibResolver()!), env: 'rust', leanOf, entryPoints: entries })
if (!built.ok) {
  ok('the program builds for rust', false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const emitted = emitRust(built.program)
  const statics: [string, string][] = [
    ['first', 'Spot'],
    ['place', 'HostPlace'],
    ['made', 'Spot'],
  ]
  for (const [name, type] of statics) {
    const upper = `MODULE_${name.toUpperCase()}`
    ok(`${name}: one LazyLock static`, emitted.includes(`static ${upper}: std::sync::LazyLock<${type}> = std::sync::LazyLock::new(||`), (emitted.match(new RegExp(`.*${upper}:.*`)) ?? [''])[0])
    ok(`${name}: no thread_local`, !new RegExp(`thread_local! \\{ static ${upper}:`).test(emitted))
    ok(`${name}: no read through with`, !emitted.includes(`${upper}.with(`))
  }
  ok('seen: the written list stays thread_local', /thread_local! \{ static MODULE_SEEN: std::rc::Rc<std::cell::RefCell<Vec<String>>> = /.test(emitted), (emitted.match(/.*MODULE_SEEN:.*/) ?? [''])[0])
  ok('the only thread_local module binding is seen', (emitted.match(/thread_local! \{ static MODULE_/g) ?? []).length === 1)
  const rust = `${emitted}
fn main() {
    let here = read_sync(1);
    let there = std::thread::spawn(|| read_sync(2)).join().unwrap();
    let seen = read_seen(1);
    let again = read_seen(2);
    print!("{}|{}|{}|{}", here, there, seen, again);
}
`
  const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' })
  if (rustc.status !== 0) {
    console.log('skip  rustc  (not installed)')
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'term-rust-module-static-'))
    writeFileSync(join(dir, 'main.rs'), rust)
    const binary = join(dir, 'main')
    const out = spawnSync('rustc', ['--edition', '2021', '-A', 'warnings', '-o', binary, join(dir, 'main.rs')], { encoding: 'utf8' })
    const errors = out.stderr.split('\n').filter(l => /^error/.test(l))
    ok('rustc compiles it', out.status === 0, errors.join(' | '))
    if (out.status === 0) {
      const ran = spawnSync(binary, [], { encoding: 'utf8' })
      ok('Rust prints what node does', ran.stdout === want, ran.stdout)
    }
  }
}

console.log(`\nrust-module-static: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
