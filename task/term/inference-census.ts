// What the two strict inference refusals would refuse (`pnpm term:inference-census`), decisions-2026-10.md, D10.
//
// Builds every package with TERM_INFER_STRICT=1 (deck/make/code/check/strict.ts), through the CLI as `term make --all`
// builds it, and counts each refusal: a parameter no call and no use gives a type, and a call several same-arity
// definitions fit equally. Each package's full list, file and line, goes to tmp/inference-census/<package>.txt, and a
// table of the counts is printed. A package's count includes its dependencies' files it builds, as the seam census's
// did, so a stdlib file counts under every package that reaches it.
//
// Writes nothing outside tmp/.

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PARENT_ROOT, TERM_ROOT, parentPaths } from './root'

// run from the repository root, where the pnpm alias starts
const REPO = TERM_ROOT
const TERM = TERM_ROOT
const LINE = path.join(TERM, 'host/line.js')
const OUT = path.join(TERM, 'tmp/inference-census')

const PACKAGES = ['base', 'call', 'deck', 'face', 'flow', 'make', 'mark', 'mill', 'scan', 'site', 'test'].map(name => ({
  name,
  dir: path.join(TERM, 'deck', name),
}))

mkdirSync(OUT, { recursive: true })

const named = process.argv.slice(2)
const chosen = [...PACKAGES, ...(PARENT_ROOT ? [{ name: 'zone', dir: parentPaths('deck/zone')[0]! }] : [])].filter(one => named.length === 0 || named.includes(one.name))

console.log('package  unconstrained  ambiguous')

for (const pack of chosen) {
  const ran = spawnSync('node', [LINE, 'make', '--trees', '--all', '--color', 'never'], {
    cwd: pack.dir,
    encoding: 'utf8',
    env: { ...process.env, TERM_INFER_STRICT: '1' },
    maxBuffer: 256 * 1024 * 1024,
  })
  const out = `${ran.stdout}${ran.stderr}`
  // the report wraps a long message onto an indented line; read as one line
  const flat = out.replace(/\n {4}(?=\S)/g, ' ')
  // the head of each message only, which a wrap never splits
  const unconstrained = flat.match(/is never given a type/g)?.length ?? 0
  const ambiguous = flat.match(/ambiguous call/g)?.length ?? 0

  writeFileSync(path.join(OUT, `${pack.name}.txt`), out)
  console.log(`${pack.name.padEnd(8)} ${String(unconstrained).padStart(13)}  ${String(ambiguous).padStart(9)}`)
}
