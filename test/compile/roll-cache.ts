// The roll from the units (note/term/plan/incremental-best-in-class.md, steps 5 and 8). `term make` writes
// host/roll.json from every unit's own roll of the build, each typed once in the unit's build and kept with it, so a
// roll pass reads what the build already made. It must be the same roll the pass makes on its own (`term roll`, which
// builds from units writing nothing), and it must move when a file does.
// Run: npx tsx test/compile/roll-cache.ts

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSession, compileProjectSeparate } from '@term/call/code/make'
import { projectCache } from '@term/call/code/cache-store'
import { projectRoll } from '@term/call/code/roll'

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

const root = realpathSync(mkdtempSync(join(tmpdir(), 'roll-cache-')))
mkdirSync(join(root, 'code'), { recursive: true })
writeFileSync(join(root, 'deck.tree'), `deck @probe/roll\n  mark <0.0.1>\n`)

// fresh text, so no earlier run's units answer for these (unit keys are the same in every clone)
const fresh = `# run ${root.split('-').pop()} at ${Date.now()}\n`
const helper = join(root, 'code', 'helper.tree')
writeFileSync(
  helper,
  `${fresh}load @term/base/exception\n  find absence\n\ntask find-one\n  take key, like text\n  like text\n  halt absence\n    bind thing, <a key>\n`,
)
writeFileSync(join(root, 'code', 'base.tree'), `${fresh}load ./helper\n  find find-one\n\ntask main\n  like text\n  back find-one(<k>)\n`)

const session = buildSession(root)
const built = compileProjectSeparate(root, projectCache(root), 'node', session)
ok('the project builds', built.failed === 0, built.errors.join(' | '))
ok('the build hands over a roll for each unit it reached', built.rolls.size >= 2, `${built.rolls.size}`)

const plain = JSON.stringify(projectRoll(root).roll)
const fromBuild = JSON.stringify(projectRoll(root, built.rolls).roll)
ok('the roll from the build is the roll made on its own', fromBuild === plain)
ok('and names the task and what it raises', fromBuild.includes('find-one') && fromBuild.includes('absence'))
ok('and shows no field a merge reads and drops', !fromBuild.includes('__def') && !fromBuild.includes('__ends') && !fromBuild.includes('__files'))

// the hive's path from `main` to the raise crosses a unit: `main` calls the helper's task, which raises
const roll = projectRoll(root, built.rolls).roll
const main = roll.task.find(task => task.name === 'main')
const path = (main?.path as Record<string, string[]> | undefined)?.absence
ok('a raise path that crosses a unit is joined', JSON.stringify(path) === JSON.stringify(['find-one']), JSON.stringify(main))

writeFileSync(join(root, 'code', 'helper.tree'), `${readFileSync(helper, 'utf8')}\ntask find-two\n  like number\n  back 2\n`)

const rebuilt = compileProjectSeparate(root, projectCache(root), 'node', session)
const moved = JSON.stringify(projectRoll(root, rebuilt.rolls).roll)
ok('after an edit the roll holds the new task', moved.includes('find-two'))
ok('as the roll made on its own does', moved === JSON.stringify(projectRoll(root).roll))

console.log(`\nroll-cache: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
