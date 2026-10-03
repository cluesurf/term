// The navigation contract (native-navigation-0001, deck/site/code/view/navigation.tree) on a host with NO address bar,
// which is what a native app is: the abstract page answers `/` and mirrors nothing, so the history is the contract's own
// stack and nothing else. A run of moves, the current path after each, how often an effect reading the route signal woke,
// and the route parameters a pattern reads out of a path.
// Run: npx tsx test/view/navigation.ts

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { projectResolver } from '@term/call/code/make'

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

const PROGRAM = `load @term/site/code/view/navigation
  find start-navigation
  find navigate
  find navigate-replace
  find navigate-back
  find current-path
  find route-signal
  find route-param

load @term/site/code/view/reactive
  find make-effect
  find read-signal

load @term/base/code/list
  find list

form wakes
  mark shared
  link count, like number

host woken
  make wakes
    bind count, code 0

task run
  like text
  save said
    make list
  call start-navigation
  call said/push
    call current-path
  # an effect reading the route signal: it runs once now and once per move
  call make-effect
    task watch
      save seen
        call read-signal
          bind self
            call route-signal
      save woken/count
        call add
          read woken/count
          code 1
  call navigate
    text </a>
  call said/push
    call current-path
  call navigate
    text </b>
  call said/push
    call current-path
  save first-back
    call navigate-back
  call said/push
    text <{{first-back}}>
  call said/push
    call current-path
  call navigate-replace
    text </c>
  call said/push
    call current-path
  save second-back
    call navigate-back
  call said/push
    text <{{second-back}}>
  call said/push
    call current-path
  save third-back
    call navigate-back
  call said/push
    text <{{third-back}}>
  call said/push
    call current-path
  call said/push
    text <{{woken/count}}>
  call said/push
    call route-param
      text </posts/:id>
      text </posts/42>
      text <id>
  call said/push
    call route-param
      text </users/:user/posts/:post>
      text </users/ana/posts/7>
      text <user>
  call said/push
    call route-param
      text </posts/:id>
      text </posts>
      text <id>
  send back
    call said/join
      text <|>
`

const dir = mkdtempSync(join(tmpdir(), 'term-navigation-'))
const entry = join(dir, 'navigation.tree')
writeFileSync(entry, PROGRAM)

// the host with no address: the abstract page, as a native app gets it, in place of the node page's server request
const base = projectResolver(process.cwd(), 'node')
const resolve = (importPath: string, fromFile: string) =>
  base(importPath.replace(/dom\/native\/\{platform\}\/page$/, 'dom/native/page'), fromFile)
const result = compile({ file: entry, text: PROGRAM }, { resolve, env: 'node' })
ok('a program driving the contract compiles', result.ok, result.ok ? '' : [...new Set(result.diagnostics.map(d => d.message))].slice(0, 6).join(' | '))

if (result.ok) {
  const readRuntime = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)
  const file = join(dir, 'navigation.ts')
  writeFileSync(file, `${nativePrelude(result.program, 'node', readRuntime, result.typescript)}\n${result.typescript}\nconsole.log(run())\n`)
  const ran = spawnSync('npx', ['tsx', file], { encoding: 'utf8' })
  ok('it runs', ran.status === 0, ran.stderr.slice(0, 600))

  const said = ran.stdout.trim().split('\n').pop()!.split('|')
  const [start, a, b, back1, afterBack, c, back2, root, back3, stays, woken, id, user, missing] = said
  ok('it starts at the host\'s path, / with no address', start === '/', start)
  ok('navigate goes to /a, then /b', a === '/a' && b === '/b', `${a} ${b}`)
  ok('back from /b is /a', back1 === 'true' && afterBack === '/a', `${back1} ${afterBack}`)
  ok('replace takes /a\'s place with /c, keeping the depth', c === '/c', c)
  ok('back from /c is the start, since /c replaced /a', back2 === 'true' && root === '/', `${back2} ${root}`)
  ok('back at the first is refused and stays put', back3 === 'false' && stays === '/', `${back3} ${stays}`)
  ok('an effect on the route signal woke once at first and once per move: 1 + 5', woken === '6', woken)
  ok('a pattern reads its :id out of a path', id === '42', id)
  ok('a pattern with two parameters reads the one asked for', user === 'ana', user)
  ok('a path shorter than the pattern reads empty', missing === '', JSON.stringify(missing))
}

console.log(`\nnavigation: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
