// One route table on every target (native-navigation-0002). The table is lowered before checking now
// (compile/compile.ts, compile/route-lower.ts), so every backend gets a typed `route(host, path)` and `boot(url, port)`,
// and the route runtime it calls is injected (compile/load.ts, view/route-runtime.tree). The table:
//
//   hook /                 the home page
//   hook /users/:id        a parameter, read by the page's prop, and `seed load` giving the page its data
//
// TypeScript: `route` called straight onto the in-memory dom for each path. The toolkits (AppKit, UIKit, Android
// views, Compose on the desktop JVM, Jetpack Compose): an app whose `main` is only `boot`, which runs the toolkit host,
// moved to /users/42 through the navigation contract, the window read back. ROUTE_ONLY=typescript (or macos, ios,
// android, compose, compose-android) runs one leg.
// Run: npx tsx test/compile/route-table.ts

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { projectResolver } from '@term/call/code/make'
import { runToolkits } from './shared/toolkit-run'
import type { Leg } from './shared/toolkit-run'

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

// the app: two pages and a route table, the same text on every target
const TABLE = `load @term/face/code/component/text
  find text

view home
  take host, like view
  view span
    text <home>

# a page's own values drawn as text: the vocabulary's text word, since a view's static text does not interpolate
view user
  take host, like view
  take id, like text
  take name, like text
  view text
    bind content, read id
  view text
    bind content, read name

# the route's data: what a page at this path shows, from wherever the data layer keeps it
task load-user
  take path, like text
  like text
  send back, text <Ada>

hook /
  view home

hook /users/:id
  take path
    take id
      like text
  seed load, read load-user
  view user
    bind id, read id
    bind name, read data
`

// the user page drawn: its id from the path's parameter and its name from the route's load, as two texts
const drawsUser = (tree: string): boolean => />42</.test(tree) && />Ada</.test(tree)

const ONLY = process.env.ROUTE_ONLY ?? ''
const ROOT = process.cwd()

if (!ONLY || ONLY === 'typescript') {
  const program = `load @term/site/code/dom/native/memory/dom
  find view
  find create-element
  find serialize
  find clear

${TABLE}
task run
  like text
  save root
    call create-element
      text <main>
  call route
    read root
    text </>
  save at-home
    call serialize
      read root
  call clear
    read root
  call route
    read root
    text </users/42>
  save at-user
    call serialize
      read root
  send back, text <{{at-home}}|{{at-user}}>
`
  const dir = mkdtempSync(join(tmpdir(), 'term-route-table-'))
  const entry = join(dir, 'app.tree')
  writeFileSync(entry, program)
  const base = projectResolver(ROOT, 'node')
  const resolve = (importPath: string, fromFile: string) =>
    base(importPath.replace(/dom\/native\/\{platform\}\/dom$/, 'dom/native/memory/dom'), fromFile)
  const result = compile({ file: entry, text: program }, { resolve, env: 'node' })
  ok('typescript: the route table compiles, the route runtime injected', result.ok, result.ok ? '' : [...new Set(result.diagnostics.map(d => d.message))].slice(0, 6).join(' | '))

  if (result.ok) {
    ok('typescript: the dispatcher is typed, not inferred', /function route\(host: View, path: string\)/.test(result.typescript), result.typescript.match(/function route\([^)]*\)/)?.[0] ?? '')
    const readRuntime = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)
    const file = join(dir, 'app.ts')
    writeFileSync(file, `${nativePrelude(result.program, 'node', readRuntime, result.typescript)}\n${result.typescript}\nconsole.log(run())\n`)
    const ran = spawnSync('npx', ['tsx', file], { encoding: 'utf8' })
    ok('typescript: it runs', ran.status === 0, ran.stderr.slice(0, 600))
    const [home, user] = ran.stdout.trim().split('\n').pop()!.split('|')
    ok('typescript: / draws the home page', home?.includes('<span>home</span>') === true, home)
    ok('typescript: /users/42 matches /users/:id, reads id 42, and the load gives the page its data', drawsUser(user ?? ''), user)
  }
}

const program = (_leg: Leg, shot: string): string => `load @term/site/code/dom/dom
  find view
  find page-body

load @term/site/code/dom/native/toolkit/dom
  find after-launch
  find exit-app
  find serialize
  find later
  find snapshot
  find say

load @term/site/code/view/navigation
  find navigate

${TABLE}
task main
  call after-launch
    task check
      save root
        call page-body
      save start
        call serialize
          read root
      call say
        text <step home {{start}}>
      call navigate
        text </users/42>
      call later
        task moved
          save moved-tree
            call serialize
              call page-body
          call say
            text <step user {{moved-tree}}>
          call snapshot
            text <${shot}>
          call exit-app
            code 0
  call boot
    text <>
    code 0
`

function step(output: string, name: string): string {
  const line = output.split('\n').find(l => l.includes(`step ${name} `)) ?? ''

  return line.slice(line.indexOf(`step ${name} `) + `step ${name} `.length).trim()
}

function judge(leg: Leg, toolkit: string, output: string): void {
  ok(`${leg}: boot mounts the table on the window and draws / (${toolkit})`, step(output, 'home').includes('<span>home</span>'), step(output, 'home'))
  ok(`${leg}: /users/42 through the contract draws the user page with its id and its loaded data`, drawsUser(step(output, 'user')), step(output, 'user'))
}

if (ONLY !== 'typescript') {
  runToolkits(
    {
      root: ROOT,
      dir: mkdtempSync(join(tmpdir(), 'term-route-table-native-')),
      name: 'Routes',
      iosIdentifier: 'surf.term.route-table-test',
      androidIdentifier: 'surf.term.routetable',
      program,
      judge,
      ok,
      compose: true,
      composeAndroid: true,
      shots: {},
    },
    ONLY,
  )
}

console.log(`\nroute-table: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
