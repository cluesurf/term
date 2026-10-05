// `term test --ride` (note/term/guides/tests/running.md): the tests run, then run again on every edit, and only the
// test files whose closure holds the edited file run. A project of two modules, each with a test file of its own, is
// watched; one module is edited into a failing test and back. The CLI runs as a person runs it, and is stopped with
// ctrl-c, which closes the run.
// Run: npx tsx test/call/test-ride.ts

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const line = join(process.cwd(), 'host', 'line.js')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'test-ride-')))
mkdirSync(join(root, 'code'), { recursive: true })
mkdirSync(join(root, 'test'), { recursive: true })
writeFileSync(join(root, 'deck.tree'), `deck @probe/ride\n  mark <0.0.1>\n`)

const module = (name: string, value: number): string => `task ${name}\n  like number\n  send back, code ${value}\n`
const testOf = (name: string, value: number): string =>
  `load ../code/${name}\n  find ${name}\n\ntest <${name} is ${value}>\n  want hold, is-equal ${name}(), ${value}\n`

writeFileSync(join(root, 'code', 'one.tree'), module('one', 1))
writeFileSync(join(root, 'code', 'two.tree'), module('two', 2))
writeFileSync(join(root, 'test', 'one.tree'), testOf('one', 1))
writeFileSync(join(root, 'test', 'two.tree'), testOf('two', 2))

const child = spawn('node', [line, 'test', '--ride', '--color', 'never'], { cwd: root })
let output = ''
child.stdout.on('data', chunk => (output += String(chunk)))
child.stderr.on('data', chunk => (output += String(chunk)))

// the output from `from` on, once it holds `text`, or after a minute
const after = (from: number, text: string): Promise<string> =>
  new Promise(done => {
    const started = Date.now()
    const look = (): void => {
      const seen = output.slice(from)

      if (seen.includes(text) || Date.now() - started > 60_000) {
        done(seen)
      } else {
        setTimeout(look, 100)
      }
    }

    look()
  })

const first = await after(0, 'every file')
ok('the first round runs every test file', first.includes('test/one.tree') && first.includes('test/two.tree'), first)
ok('and both pass', first.includes('2 passed'), first)

// an edit to the first module, which only test/one.tree reaches, into a value its test does not want
let mark = output.length
writeFileSync(join(root, 'code', 'one.tree'), module('one', 5))
const second = await after(mark, '1 of 2 files')
ok('an edit runs the one test file that reaches it', second.includes('1 of 2 files') && second.includes('test/one.tree'), second)
ok('and not the other', !second.includes('test/two.tree'), second)
ok('and it fails, as the edit made it', second.includes('One is 1'), second)

mark = output.length
writeFileSync(join(root, 'code', 'one.tree'), module('one', 1))
const third = await after(mark, '1 of 2 files')
ok('put back, it runs again and passes', third.includes('1 passed') && !third.includes('failed'), third)

child.kill('SIGINT')
const code = await new Promise<number | null>(done => child.on('exit', done))
ok('ctrl-c closes the run', output.includes('Stopped') && code !== 0, `${code}`)

console.log(`\ntest-ride: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
