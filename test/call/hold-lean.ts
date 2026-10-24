// `term hold --lean`: the second checker from the CLI (call/code/hold-lean.ts, note/project/term/proof/lean-export/).
// Run: npx tsx test/call/hold-lean.ts   (Lean at TERM_LEAN, else on the PATH)
//
// Through the built CLI (test/call/cli.ts), on the notes demo (test/assurance/notes):
//   - with Lean: every one of the demo's claims (29 on 2026-10-21) prints `lean <claim> checked`, none rests on an axiom, the total says
//     29 of 29, the Lean file is under the project's home, `--json` carries the same verdicts, and it exits 0
//   - with a planted wrong proof (law 1 by the empty shelf's evidence, planted into the exported Lean file and handed to
//     Lean by a wrapper at TERM_LEAN): `ownership` is reported refused with Lean's error line, and it exits 1
//   - with TERM_LEAN naming nothing and no Lean on the PATH: it exits non-zero with the one line that installs Lean
// With no Lean on this machine the first two are reported skipped, never passed. The third runs everywhere.

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { exportLean, joinSources, plantLean } from '@term/make/code/check/lean-export'
import { findLean } from '@term/make/code/check/lean-run'
import { projectHome } from '@term/call/code/home'
import { LINE } from './cli'

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

const TERM = new URL('../../', import.meta.url).pathname
const NOTES = join(TERM, 'test/assurance/notes')
const TMP = join(TERM, 'tmp/hold-lean')
// the demo's claims, as the exporter reads them from the two files that state them (29 on 2026-10-21)
const CLAIMS = exportLean(
  joinSources(['model.tree', 'law.tree'].map(file => ({ file: `notes/${file}`, text: readFileSync(join(NOTES, 'code', file), 'utf8') }))),
).claims.length

mkdirSync(TMP, { recursive: true })

function hold(args: string[], env: Record<string, string>): { status: number | null; out: string; stdout: string } {
  const run = spawnSync(process.execPath, [LINE, 'hold', '--lean', ...args], {
    cwd: NOTES,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...env },
    timeout: 900_000,
    maxBuffer: 64 * 1024 * 1024,
  })

  return { status: run.status, out: `${run.stdout ?? ''}${run.stderr ?? ''}`, stdout: run.stdout ?? '' }
}

const lean = findLean()

if (lean) {
  // THE DEMO: every claim checked, none on an axiom
  const good = hold([], { TERM_LEAN: lean })
  const checked = [...good.out.matchAll(/lean (\S+) checked$/gm)].map(m => m[1])
  ok(`all ${CLAIMS} claims print checked`, checked.length === CLAIMS && new Set(checked).size === CLAIMS, `${checked.length}: ${good.out.slice(-3000)}`)
  ok('no claim rests on an axiom, is refused or declined', !/rests on|refused:|declined:/.test(good.out), good.out.slice(-2000))
  ok(`the total says ${CLAIMS} of ${CLAIMS}`, new RegExp(`${CLAIMS} of ${CLAIMS} claims checked by Lean`).test(good.out) && /0 refused · 0 on an axiom · 0 declined/.test(good.out), good.out.slice(-1500))
  ok('it holds and exits 0', good.status === 0 && /hold Holds/.test(good.out), `exit ${good.status}`)

  const file = projectHome(NOTES, 'lean', 'hold.lean')
  const written = readFileSync(file, 'utf8')
  ok('the Lean file is under the project home, one #print axioms line per claim', (written.match(/^#print axioms /gm) ?? []).length === CLAIMS)

  // the same verdicts as data
  const asJson = hold(['--json'], { TERM_LEAN: lean })
  const data = JSON.parse(asJson.stdout) as { lean?: { ok: boolean; claims: { verdict: string }[] } }
  ok('--json carries every claim checked', data.lean?.ok === true && data.lean.claims.length === CLAIMS && data.lean.claims.every(c => c.verdict === 'checked'), asJson.stdout.slice(0, 500))

  // THE PLANT: law 1 by `fair-shelf.clean`, which proves `fair-shelf bare`, not `fair-shelf s`. Term's kernel would
  // refuse it in the source, so it is planted into the exported file, and a wrapper at TERM_LEAN hands Lean that
  const planted = join(TMP, 'planted.lean')
  writeFileSync(planted, plantLean(written, 'ownership', '@TermExport.«fair-shelf».«clean»'))
  const wrapper = join(TMP, 'lean-planted')
  writeFileSync(wrapper, `#!/bin/sh\ncase "$1" in --version) exec "${lean}" --version ;; esac\nexec "${lean}" "${planted}"\n`)
  chmodSync(wrapper, 0o755)

  const bad = hold([], { TERM_LEAN: wrapper })
  ok('the planted claim is refused with Lean\'s error line', /lean ownership refused: \d+:\d+: error: Type mismatch/.test(bad.out), bad.out.slice(-3000))
  ok('law 1 of replay is refused for resting on it', /lean ownership-of-replay refused: it rests on ownership/.test(bad.out), bad.out.slice(-3000))
  ok(`the total says ${CLAIMS - 2} of ${CLAIMS}, 2 refused`, new RegExp(`${CLAIMS - 2} of ${CLAIMS} claims checked by Lean`).test(bad.out) && /2 refused/.test(bad.out), bad.out.slice(-1500))
  ok('it does not hold and exits 1', bad.status === 1 && /Does not hold/.test(bad.out), `exit ${bad.status}`)
} else {
  console.log('skip  no Lean at TERM_LEAN or on the PATH: the demo and the plant did not run. Set TERM_LEAN=/opt/homebrew/bin/lean')
}

// NO LEAN: TERM_LEAN names nothing and the PATH holds no lean. Never a silent pass
const none = hold([], { TERM_LEAN: join(TMP, 'no-such-lean'), PATH: '/usr/bin:/bin' })
ok('with no Lean it exits non-zero', none.status !== 0 && none.status !== null, `exit ${none.status}`)
ok('with no Lean it says how to install it', /brew install elan-init, then elan default leanprover\/lean4:stable/.test(none.out), none.out.slice(-1500))
ok('with no Lean it re-checks nothing', /No claim was re-checked in Lean/.test(none.out) && !/ checked$/m.test(none.out), none.out.slice(-1500))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
