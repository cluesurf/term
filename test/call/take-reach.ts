// take-reach: a take a wrapper task receives and passes nowhere is DROPPED, and the check names it (decision
// cli-in-term/013 part 2, task/term/take-reach.ts). A fixture console with one wrapper that passes every take on, one
// that reads a take and drops another, one whose verb never reads what it is handed, and a take no parameter receives.
// Run: npx tsx test/call/take-reach.ts

//
// The check is run as its own process, as cli-drift's caller runs it: task/term/ is CommonJS, so this module (an ES
// module under the term package) cannot import its names.

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tempDir } from '../temp'

const TERM = resolve(import.meta.dirname, '../..')
const CHECK = resolve(TERM, '../../../../task/term/take-reach.ts')

let pass = 0
let fail = 0

function expect(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)

  if (g === w) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (got ${g}, want ${w})`)
  }
}

const SRC = `task keep
  take value, like text
  like text
  send back, read value

# a verb that reads both of its takes
task ship
  take file, like text
  take out, like text
  like text
  save first
    call keep
      read file
  send back
    call keep
      read out

# a wrapper that passes every take on: nothing dropped
task ship-project
  take file, like text
  take out, like text
  like text
  send back
    call ship
      read file
      read out

# a wrapper that takes out and passes it nowhere, the make-project shape
task pack-project
  take file, like text
  take out, like text
  like text
  send back
    call keep
      read file

# a verb handed out that never reads it
task half
  take file, like text
  take out, like text
  like text
  send back
    call keep
      read file

# a wrapper that passes both on, verbatim, to a verb that drops one: the check reads the program before the
# simplifier inlines such a forwarder, so the drop is named against the verb
task half-project
  take file, like text
  take out, like text
  like text
  send back
    call half
      read file
      read out

hook tool
  hook ship
    take file
    take out
    task ship-project
  hook pack
    take file
    take out
    task pack-project
  hook half
    take file
    take out
    take extra
    task half-project
`

const dir = tempDir('take-reach-')
const file = join(dir, 'base.tree')
writeFileSync(file, SRC)

// the loader this process runs under (tsx) runs the check too
const run = (args: string[]) =>
  spawnSync(process.execPath, [...process.execArgv, CHECK, ...args], { cwd: TERM, encoding: 'utf8' })

const routes = run(['--file', file, '--routes'])
const commands = JSON.parse(routes.stdout || '[]') as { path: string; task?: string }[]
expect('the commands read', commands.map(command => `${command.path}:${command.task}`), [
  'ship:ship-project',
  'pack:pack-project',
  'half:half-project',
])

const checked = run(['--file', file])
const lines = checked.stdout.split('\n').filter(line => line.startsWith('dropped: '))
expect('the drops', lines, [
  'dropped: pack --out (pack-project never reads it)',
  'dropped: half --out (half never reads it)',
  'dropped: half --extra (half-project has no parameter for it)',
])
expect('the passing wrapper drops nothing', lines.filter(line => line.includes(' ship ')), [])
expect('the count', checked.stdout.includes('take-reach: 3 dropped'), true)
expect('exit 1 on a drop', checked.status, 1)

if (checked.status !== 1 || lines.length === 0) {
  console.log(checked.stderr.slice(0, 2000))
}

console.log(`\ntake-reach: ${pass} passed, ${fail} failed`)

if (fail > 0) {
  process.exit(1)
}
