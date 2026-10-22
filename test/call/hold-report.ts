// `term hold --report`: the MVP report (call/code/hold-report.ts, note/project/term/assurance/mvp.md section 3,
// decision note/project/term/proof/lean-export/decision/001-laws-manifest.md).
// Run: npx tsx test/call/hold-report.ts
//
// Through the built CLI (host/line.js):
//   - the notes demo (test/assurance/notes, its laws.tree naming 7 laws): every law holds, each row carries its English
//     from the Term form (a rule through law-english.ts, a mark from the mark, tier 0 from its count), the top line
//     says 7 laws hold, the page is written under the project's home as printed, and it exits 0
//   - twin/ownership-skip: the report names ownership as the law that does not hold, with the refusal inside it
//   - twin/no-forged-permit: the report names no-forged-permit, with the `hidden-make` refusal
//   - a project with no laws.tree (twin/isolation): the top line says no law is named, and it exits 1

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { projectHome } from '@term/call/code/home'

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
const LINE = join(TERM, 'host/line.js')
const ASSURANCE = join(TERM, 'test/assurance')

function hold(dir: string, args: string[] = []): { status: number | null; out: string; stdout: string } {
  const run = spawnSync(process.execPath, [LINE, 'hold', '--report', '--quiet', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  })

  return { status: run.status, out: `${run.stdout ?? ''}${run.stderr ?? ''}`, stdout: run.stdout ?? '' }
}

// THE DEMO
const notes = join(ASSURANCE, 'notes')
const good = hold(notes)
const LAWS = ['ownership', 'no-forged-permit', 'every-mutating-route-asks', 'deleted-stays-gone', 'isolation', 'no-crash', 'safe-text']

ok('the top line says 7 laws hold', /^✓ 7 laws hold, \d+ obligations, \d+ contracts/m.test(good.stdout), good.stdout.slice(0, 800))
ok('the top line says how many tasks the kernel declined', /tasks declined by the kernel/.test(good.stdout.split('\n')[2] ?? ''))

for (const law of LAWS) {
  ok(`${law} holds, resting on nothing`, new RegExp(`^${law}\\s+holds\\s+rests on: nothing$`, 'm').test(good.stdout), good.stdout.slice(0, 3000))
}

// the English, from the Term form: a rule's sentence, a mark's, tier 0's
ok('law 1 reads in English from its rules', /For every events es, fair-shelf holds of \(the replay of es\)\./.test(good.stdout))
ok('law 2 reads from its mark', /only code\/model\.tree makes a permit/.test(good.stdout))
ok('law 3 reads from its marks', /a permit is used at most once/.test(good.stdout) && /only code\/permit\.tree calls bury-at/.test(good.stdout))
ok('law 6 reads from the tier-0 count', /every division is by something other than zero.*: \d+ of \d+ obligations proven/.test(good.stdout))
ok('law 7 reads in English from its rule', /For every page pg, safe-html holds of/.test(good.stdout))
ok('the assumed list names the outside calls', /^assumed \(outside calls, each an axiom\):\n {2}code\/site\.tree /m.test(good.stdout))
ok('the counts line is there', /^not proven: 0 tasks\. declined by the kernel: \d+ tasks$/m.test(good.stdout))
ok('the page is written under the home as printed', readFileSync(projectHome(notes, 'report', 'hold.txt'), 'utf8') === good.stdout, '')
ok('the demo holds and exits 0', good.status === 0, `exit ${good.status}`)

// A LEMMA IS NOT A LAW: ownership-carry is a claim of law.tree and no row
ok('a claim the manifest does not name is not a row', !/^ownership-carry\s/m.test(good.stdout))

// THE TWINS: the failing law named, with the refusal that fails it
const skip = hold(join(ASSURANCE, 'twin/ownership-skip'))
ok('ownership-skip: the top line names ownership', /^✗ 0 of 1 laws hold, 1 does not \(ownership\)/m.test(skip.stdout), skip.out.slice(0, 1500))
ok('ownership-skip: the row says why, inside the law', /^ownership\s+does not hold/m.test(skip.stdout) && /why: .*code\/law\.tree:\d+/.test(skip.stdout), skip.stdout.slice(0, 1500))
ok('ownership-skip: it exits 1', skip.status === 1, `exit ${skip.status}`)

const forged = hold(join(ASSURANCE, 'twin/no-forged-permit'))
ok('no-forged-permit: the top line names it', /^✗ 0 of 1 laws hold, 1 does not \(no-forged-permit\)/m.test(forged.stdout), forged.out.slice(0, 1500))
ok('no-forged-permit: the row quotes the hidden-make refusal', /why: "permit" is `mark hide`/.test(forged.stdout), forged.stdout.slice(0, 1500))
ok('no-forged-permit: it exits 1', forged.status === 1, `exit ${forged.status}`)

// NO MANIFEST: a report that names no law proves nothing, and fails
const bare = hold(join(ASSURANCE, 'twin/isolation'))
ok('no laws.tree: the top line says so', /there is no laws\.tree at the project root/.test(bare.stdout.split('\n')[2] ?? ''), bare.stdout.slice(0, 800))
ok('no laws.tree: it exits 1', bare.status === 1, `exit ${bare.status}`)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
