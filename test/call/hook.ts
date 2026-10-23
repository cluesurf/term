// CLI `hook` DSL dispatch test: compile a command tree, then resolve real argv against it (subcommand descent, flags,
// positionals, the bound task). Run: npx tsx test/call/hook.ts

import { compile } from '@term/make/code/compile/compile'
import {
  commandRoutes,
  dispatch,
  programOf,
  runCommandLine,
} from '@term/call/code/hook-dispatch'

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
    take verbose
      like boolean
    task make-face

hook load
  slot name
  task load-deck

hook lock
  take cite
  take code
    wait rise
  task make-deck

task pair
  take first, like text
  take second, like text
  send back
    code 0

hook pair
  take second
  take first
  task pair

task repeat
  take times, like number
  send back
    code 0

hook repeat
  take times
    like number
  task repeat

task join
  take words, like list, like text
  send back
    code 0

hook join
  slot words, like list, like text
  task join

task gather
  take items, like list
  send back
    code 0

hook gather
  slot items
    like list
  task gather
`

function main(): Promise<void> {
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
    'gather',
    'join',
    'load',
    'lock',
    'make',
    'pair',
    'repeat',
  ])

  // A LIST SLOT IS THE REST OF THE WORDS: its type says so, with no marker (`many` until 2026-10-05), whether the
  // element is written (`like list, like text`) or not (`like list`). A list `take` under a command is refused
  // (decision term/003 part 1, test/compile/hook-route.ts)
  const join = dispatch(routes, ['join', 'The', 'Name', 'of', 'the', 'Rose'])
  expect('a list take collects every word left', join.ok && join.args.words, ['The', 'Name', 'of', 'the', 'Rose'])
  const gather = dispatch(routes, ['gather', 'a.txt', 'b.txt'])
  expect('a bare `like list` collects them too', gather.ok && gather.args.items, ['a.txt', 'b.txt'])
  const one = dispatch(routes, ['load', 'one'])
  expect('a text take still holds one word', one.ok && one.args.name, 'one')

  // and the retired marker is REFUSED by name. Unread, it was dropped in silence and the take held one word of text
  const retired = compile(
    { file: 'many.tree', text: 'task join\n  take words, like text\n  send back\n    code 0\n\nhook join\n  take words\n    like text\n    many\n  task join\n' },
    {},
  )
  expect(
    'a `many` is refused, naming the list type',
    !retired.ok && retired.diagnostics.some(d => d.message.includes('`many` is retired') && d.message.includes('like list')),
    true,
  )

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

  // positional bound to the first slot
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

  // a flag no take names is refused, not ignored (guides: applications/command-line)
  const typo = dispatch(routes, ['make', '--typo', 'x'])
  expect('unknown flag rejected', typo.ok, false)
  expect('and named', !typo.ok && typo.error.includes('--typo'), true)

  // a word no take is left to hold is refused
  const extra = dispatch(routes, ['load', 'one', 'two'])
  expect('leftover argument rejected', extra.ok, false)

  // a `like number` take refuses a value that is not a whole number
  const notNumber = dispatch(routes, ['repeat', '--times', 'x'])
  expect('non-number rejected', notNumber.ok, false)
  const half = dispatch(routes, ['repeat', '--times', '1.5'])
  expect('fraction rejected for a whole number', half.ok, false)
  const three = dispatch(routes, ['repeat', '--times', '3'])
  expect('whole number accepted', three.ok && three.args.times, 3)

  // the task's parameters are filled by name, whatever order the hook lists its takes in
  const pairCall = routes.find(route => route.path === 'pair')?.calls[0]
  expect('a bound call carries its task parameters', pairCall?.params, ['first', 'second'])

  // ONE PROGRAM HOOK (decision term/003 part 3): its nested hooks are the commands and its takes the global options,
  // accepted on every command and handed to the console (`globals`), never to the task. A positional binds to a slot
  // only, and a long alias reaches its take
  const PROGRAM = `task build
  take file, like text
  take ride, like boolean
  send back
    code 0

hook tool
  take quiet
    like boolean
    code q
  take color
    like text
    pick auto
    pick never
    bind <auto>
  hook build
    slot file
      like text
    take ride, name watch
      like boolean
    task build
`
  const built = compile({ file: 'program.tree', text: PROGRAM }, {})

  if (!built.ok) {
    console.log('FAIL compile program', JSON.stringify(built.diagnostics.slice(0, 3)))
    process.exit(1)
  }

  const program = commandRoutes(built.program)
  expect('the program is read as its commands', programOf(program).commands.map(route => route.path), ['build'])
  const run = dispatch(program, ['build', 'a.tree', '--watch', '-q', '--color', 'never'])
  expect('a slot takes the positional', run.ok && run.args.file, 'a.tree')
  expect('a long alias reaches its take', run.ok && run.args.ride, true)
  expect('a global is the console\'s', run.ok && run.globals, { quiet: true, color: 'never' })
  expect('and never the task\'s', run.ok && Object.keys(run.args).sort(), ['file', 'ride'])
  const noSlot = dispatch(program, ['build', '--ride', 'a.tree', 'b.tree'])
  expect('a word no slot holds is refused', noSlot.ok, false)
  const badGlobal = dispatch(program, ['build', '--color', 'red'])
  expect('a global\'s choices are checked', badGlobal.ok, false)
  const dashed = dispatch(program, ['build', 'a.tree', '--', 'run', '--help'])
  expect('words after -- no slot holds are left to the task, not refused', [dashed.ok, dashed.ok && dashed.args.file], [true, 'a.tree'])

  // A PASSING COMMAND (`mark pass`, decision cli-in-term/008 part 2): every word after its path reaches its one slot
  // verbatim, `--help`, `--` and unknown or global flags included; words before it are still the console's
  const PASSING = `task hand
  take rest, like list, like text
  send back
    code 0

hook tool
  take quiet
    like boolean
    code q
  hook zone
    mark pass
    slot rest, like list, like text
    task hand
`
  const passBuilt = compile({ file: 'passing.tree', text: PASSING }, {})

  if (!passBuilt.ok) {
    console.log('FAIL compile passing', JSON.stringify(passBuilt.diagnostics.slice(0, 3)))
    process.exit(1)
  }

  const passing = commandRoutes(passBuilt.program)
  const helped = dispatch(passing, ['zone', '--help'])
  expect('a passing route gets --help', helped.ok && helped.args.rest, ['--help'])
  const listed = dispatch(passing, ['zone', 'list', '--quiet'])
  expect('a passing route gets its words and flags in order', listed.ok && listed.args.rest, ['list', '--quiet'])
  expect('a global after a passing command is not the console\'s', listed.ok && listed.globals, {})
  const raw = dispatch(passing, ['zone', '-h', '--', '--typo', 'x'])
  expect('-h, -- and an unknown flag pass verbatim', raw.ok && raw.args.rest, ['-h', '--', '--typo', 'x'])

  const seen: unknown[] = []
  const shown: string[] = []
  const runPassing = (argv: string[]): Promise<number> =>
    runCommandLine({
      name: 'tool',
      routes: passing,
      argv,
      resolve: () => (rest: unknown) => {
        seen.push(rest)
        return 0
      },
      out: line => shown.push(line),
      err: line => shown.push(line),
    })

  return runPassing(['zone', '--help'])
    .then(code => {
      expect('runCommandLine hands --help after a passing command to it', [code, seen[0]], [0, ['--help']])
      shown.length = 0
      return runPassing(['--help', 'zone'])
    })
    .then(code => {
      expect('--help before a passing command is the console\'s help of it', [code, seen.length, shown[0]?.startsWith('tool zone')], [0, 1, true])
      shown.length = 0
      return runCommandLine({
        name: 'tool',
        routes: program,
        argv: ['build', '--', '--help'],
        resolve: () => () => 0,
        out: line => shown.push(line),
        err: line => shown.push(line),
      })
    })
    .then(code => {
      expect('--help after a literal -- is not the console\'s help', [code, shown.some(line => line.startsWith('tool build'))], [0, false])
      console.log(`\nhook: ${pass} pass, ${fail} fail`)

      if (fail) {process.exit(1)}
    })
}

main()
