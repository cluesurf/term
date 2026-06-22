// CLI `hook` DSL dispatch test: compile a command tree, then resolve real argv against it (subcommand descent, flags,
// positionals, the bound task). Run: npx tsx test/call/hook.ts

import { compile } from '@cluesurf/make/code/compile/compile'
import {
  commandRoutes,
  dispatch,
} from '@cluesurf/call/code/hook-dispatch'

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

const SRC = `task make-deck
  take name, like text
  send back
    code 0

task make-face
  take name, like text
  send back
    code 0

task load-deck
  take name, like text
  send back
    code 0

hook make
  take name
  take title
    code t
  task make-deck
  hook face
    take name
    task make-face

hook load
  take name
  task load-deck

hook lock
  take cite
  take code
    wait rise
  task make-deck
`

function main(): void {
  const r = compile({ file: 'cli.tree', text: SRC }, {})

  if (!r.ok) {
    console.log(
      'FAIL compile',
      JSON.stringify(r.diagnostics.slice(0, 3)),
    )
    process.exit(1)
  }

  const routes = commandRoutes(r.program)
  expect('top-level commands', routes.map(c => c.path).sort(), [
    'load',
    'lock',
    'make',
  ])

  // top-level command + flag
  const a = dispatch(routes, ['make', '--name', 'x'])
  expect('make: ok', a.ok, true)
  expect('make: task', a.ok && a.task, 'make-deck')
  expect('make: command path', a.ok && a.command, ['make'])
  expect('make: flag arg', a.ok && a.args.name, 'x')

  // subcommand descent + flag
  const b = dispatch(routes, ['make', 'face', '--name', 'y'])
  expect('make face: task', b.ok && b.task, 'make-face')
  expect('make face: path', b.ok && b.command, ['make', 'face'])
  expect('make face: arg', b.ok && b.args.name, 'y')

  // positional bound to the first take
  const c = dispatch(routes, ['load', 'mydeck'])
  expect('load positional -> task', c.ok && c.task, 'load-deck')
  expect('load positional -> name', c.ok && c.args.name, 'mydeck')

  // --flag=value form
  const d = dispatch(routes, ['make', '--name=z'])
  expect('flag=value', d.ok && d.args.name, 'z')

  // boolean flag (no value follows)
  const e = dispatch(routes, ['make', 'face', '--verbose'])
  expect('boolean flag', e.ok && e.args.verbose, true)

  // short flag `-t` resolves to the take's full name `title`
  const make = routes.find(c => c.path === 'make')!
  expect(
    'short flag parsed',
    make.takes.find(t => t.name === 'title')?.short,
    't',
  )

  const g = dispatch(routes, ['make', '-t', 'Hello'])
  expect(
    'short flag dispatches to full name',
    g.ok && g.args.title,
    'Hello',
  )

  const g2 = dispatch(routes, ['make', '-t=Hi'])
  expect('short flag = value', g2.ok && g2.args.title, 'Hi')

  // masked input flag captured (`wait rise`)
  const lock = routes.find(c => c.path === 'lock')!
  expect(
    'masked take captured',
    lock.takes.find(t => t.name === 'code')?.masked,
    true,
  )

  // unknown command
  const f = dispatch(routes, ['nope'])
  expect('unknown command rejected', f.ok, false)

  console.log(`\nhook: ${pass} pass, ${fail} fail`)

  if (fail) {process.exit(1)}
}

main()
