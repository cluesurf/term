// Terminal screens behind the navigation contract (native-navigation-0005, deck/site/code/dom/native/terminal/routes.tree):
// a route table in the route DSL, mounted in the terminal host by `mount-routes`, moved by the contract's `navigate`
// and back by a key, as a person at a terminal would. Each screen is painted into the cell grid. It runs on TypeScript,
// Rust, Swift and Kotlin, and every backend must draw the same three screens: home, the user page with the id the
// path carried, and home again after Escape.
// Run: npx tsx test/view/terminal-routes.ts   (TERMINAL_ONLY=rust for one backend)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import type { Resolver } from '@term/make/code/compile/load'
import { BACKENDS, runOn } from '../compile/shared/run-on'

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

// a 12 by 1 screen: the page's one line
const WANT = ['home', 'user 7', 'home']

const PROGRAM = `load @term/site/code/dom/native/terminal/dom
  find view
  find paint-screen
  find press-key

load @term/site/code/dom/native/terminal/routes
  find mount-routes

load @term/site/code/view/navigation
  find navigate

view home-page
  take host, like view
  view span
    text <home>

view user-page
  take host, like view
  take id, like text
  view span
    text <user >
    read id

hook /
  view home-page

hook /users/:id
  take path
    take id
      like text
  view user-page
    bind id, read id

task run
  like text
  save root
    call mount-routes
      read route
      text <Escape>
  save first
    call paint-screen
      read root
      code 12
      code 1
  call navigate
    text </users/7>
  save second
    call paint-screen
      read root
      code 12
      code 1
  call press-key
    read root
    text <escape>
  save third
    call paint-screen
      read root
      code 12
      code 1
  send back, text <{first}|{second}|{third}>
`

function pinned(env: string): Resolver {
  const base = projectResolver(process.cwd(), env)

  // the dom contract read as the terminal's. On node the app host is pinned too, to the one that runs routes in a
  // terminal: it is otherwise the HTTP server, which docks hono, and a terminal program has no server to start. Swift
  // and Kotlin keep the abstract host, which mounts nothing, since they have no terminal loop
  const host = env === 'node' ? 'view/native/rust/host' : 'view/native/{platform}/host'

  return (importPath, fromFile) =>
    base(importPath.replace(/native\/\{platform\}\/dom$/, 'native/terminal/dom').replace(/view\/native\/\{platform\}\/host$/, host), fromFile)
}

const dir = mkdtempSync(join(tmpdir(), 'term-terminal-routes-'))
const only = process.env.TERMINAL_ONLY ?? ''

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: pinned, dir, name: 'routes' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(`${backend}: the route table compiles, builds and runs in the terminal host`, ran.form === 'ran', ran.form === 'failed' ? `${ran.stage}: ${ran.reason}` : '')

  if (ran.form === 'ran') {
    const screens = ran.output.split('|')
    ok(`${backend}: / draws the home page`, screens[0] === WANT[0], JSON.stringify(screens[0]))
    ok(`${backend}: navigating to /users/7 draws the user page with the id the path carried`, screens[1] === WANT[1], JSON.stringify(screens[1]))
    ok(`${backend}: Escape goes back, and home is drawn again`, screens[2] === WANT[2], JSON.stringify(screens[2]))
  }
}

console.log(`\nterminal-routes: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
