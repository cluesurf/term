// The terminal output library answers the same on Rust as on TypeScript. deck/call/test/item/parity.tree draws a
// handful of items in every shape the cards use, at 80 and 40 columns, in Unicode and ASCII; this emits it for node and
// for rust with the built CLI, runs both, and holds every line equal. `rustc` compiling the modules proves they type;
// this proves they say the same thing.
//
// Needs rustc, skipped without it. Run: npx tsx test/item/rust-parity.ts

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { transformSync } from 'esbuild'
import { runDir } from '../compile/run-dir'

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n${detail}` : ''}`)
  }
}

function have(tool: string): boolean {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' })

    return true
  } catch {
    return false
  }
}

const PACKAGE = join(process.cwd(), 'deck/call')
const CLI = join(process.cwd(), 'host/line.js')
const SOURCE = 'test/item/parity.tree'
const dir = runDir('term-item-parity-')

// one program for one backend, emitted by the CLI from the package, so its role (lean) applies
function emit(target: string, out: string): { ok: boolean; why: string } {
  const run = spawnSync(process.execPath, [CLI, 'make', '--emit', target, SOURCE, '--out', out, '--log', 'json'], { cwd: PACKAGE, encoding: 'utf8' })

  return { ok: run.status === 0, why: `${run.stdout}${run.stderr}`.slice(0, 1200) }
}

if (!have('rustc')) {
  console.log('skip  rust parity  (rustc not installed)')
  console.log('\nitem/rust-parity: 0 pass, 0 fail, 1 skipped')
  process.exit(0)
}

const ts = join(dir, 'parity.ts')
const rs = join(dir, 'parity.rs')
const node = emit('node', ts)
const rust = emit('rust', rs)
ok('the program emits for node', node.ok, node.why)
ok('the program emits for rust', rust.ok, rust.why)

if (node.ok && rust.ok) {
  // each backend's entry: the program declares `draw-samples` and the harness prints what it answers
  const js = join(dir, 'parity.mjs')
  writeFileSync(js, `${transformSync(readFileSync(ts, 'utf8'), { loader: 'ts', format: 'esm' }).code}\nprocess.stdout.write(drawSamples())\n`)
  const fromNode = spawnSync(process.execPath, [js], { encoding: 'utf8' })
  writeFileSync(rs, `${readFileSync(rs, 'utf8')}\nfn main() { print!("{}", draw_samples()); }\n`)

  const binary = join(dir, 'parity')
  const built = spawnSync('rustc', ['--edition', '2021', '-O', '-A', 'warnings', '-o', binary, rs], { encoding: 'utf8' })
  ok('the program builds with rustc', built.status === 0, built.stderr.slice(0, 1200))

  if (built.status === 0) {
    const fromRust = spawnSync(binary, [], { encoding: 'utf8' })
    const a = fromNode.stdout.split('\n')
    const b = fromRust.stdout.split('\n')
    ok('node drew the samples', fromNode.status === 0 && a.length > 40, fromNode.stderr.slice(0, 600))
    ok('rust drew the samples', fromRust.status === 0 && b.length > 40, fromRust.stderr.slice(0, 600))

    const differ = a
      .map((line, at) => ({ at, node: line, rust: b[at] ?? '<missing>' }))
      .filter(one => one.node !== one.rust)
    ok(
      `every line the same on both (${a.length} lines)`,
      differ.length === 0 && a.length === b.length,
      differ
        .slice(0, 6)
        .map(one => `  line ${one.at}\n    node |${one.node}|\n    rust |${one.rust}|`)
        .join('\n'),
    )
  }
}

console.log(`\nitem/rust-parity: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
