// A console in the hook dialect lowers to route data a dispatcher and a help renderer can read (decision term/003
// parts 1 and 2, term-cli-in-term-0140): a `slot` under a hook is a positional (`positional`, and `variadic` too when
// list-typed), a take's long aliases are its `name` lines in order (`aliases`), and both reach the JSON
// compile/node-json.tree writes, the form the route data travels in. A list-typed `take` under a command is a
// repeatable option (decision cli-in-term/010), a slot with a line the hook-slot rule does not read (`code`) is refused instead of dropped, and a
// task's own `slot` parameter means what it meant.
// Run: npx tsx test/compile/hook-route.ts

import { compile } from '@term/make/code/compile/compile'
import { statementJson } from '@term/make/code/compile/node-json'
import type { Statement } from '@term/make/code/compile/node'
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

type Dock = Extract<Statement, { form: 'dock' }>

const asCall = { roleOf: (): string => 'call' }

const CONSOLE = `# The tool
hook tool
  # Print less
  take quiet
    like boolean
    code q

  # Build one file
  hook make
    # the file to build
    slot file
      like text
    # Watch files
    take ride, name watch
      like boolean
    # Show help
    take hint
      name help
      name assist
      like boolean
      code h
    take back
      like text
      pick json
      pick line
      bind <line>
    task build

  # Gather paths
  hook gather
    slot root
      like text
      need true
    slot paths, like list, like text
    task gather

task build
  take file, like text
  take ride, like boolean
  take hint, like boolean
  take back, like text
  like text

  send back, read file

task gather
  take root, like text
  take paths, like list, like text
  like text

  send back, read root
`

const out = compile({ file: '/gate/code/line/base.tree', text: CONSOLE }, asCall)
ok('the console compiles', out.ok, out.ok ? '' : out.diagnostics.map(d => d.message).join(' | '))

const program = out.ok ? out.program : []
const dock = program.find((s): s is Dock => s.form === 'dock' && s.route.path === 'tool')
ok('the program hook is one route', dock !== undefined)

const json = dock ? statementJson(['span', 'type'], dock) : ''
const takesOf = (path: string): string => {
  const at = json.indexOf(`"path":${JSON.stringify(path)}`)
  const start = json.indexOf('"takes":[', at)

  if (at < 0 || start < 0) {
    return ''
  }

  // the takes list ends where the route's methods begin
  return json.slice(start + '"takes":'.length, json.indexOf(',"methods":', start))
}

const quiet = '{"name":"quiet","required":false,"short":"q","note":"Print less"}'
ok('the program keeps its own take', takesOf('tool') === `[${quiet}]`, takesOf('tool'))

const make = [
  '{"name":"file","required":false,"note":"the file to build","positional":true}',
  '{"name":"ride","required":false,"aliases":["watch"],"note":"Watch files"}',
  '{"name":"hint","required":false,"short":"h","aliases":["help","assist"],"note":"Show help"}',
  '{"name":"back","required":false,"fallback":{"form":"text","value":"line"},"choices":["json","line"]}',
]
ok(
  'a slot is positional, aliases come in order, short, choices and fallback, all in source order',
  takesOf('make') === `[${make.join(',')}]`,
  takesOf('make'),
)

const gather = [
  '{"name":"root","required":true,"positional":true}',
  '{"name":"paths","required":false,"variadic":true,"positional":true}',
]
ok('a need-true slot is required, a list slot is variadic too', takesOf('gather') === `[${gather.join(',')}]`, takesOf('gather'))

ok(
  'the commands are the program route\'s children, in order',
  JSON.stringify(dock?.route.children.map(child => child.path)) === '["make","gather"]',
)

const refusals = (text: string): string[] => {
  const result = compile({ file: '/gate/code/line/base.tree', text }, asCall)

  return result.ok ? [] : result.diagnostics.map(d => d.message)
}

// a list-typed take under a command is a REPEATABLE option (decision cli-in-term/010, superseding that point of 003
// part 1): its type is the list, and it is neither positional nor variadic, which stay a list slot's
const listTake = compile(
  {
    file: '/gate/code/line/base.tree',
    text: `hook tool
  hook one
    take law, like list, like text
    task one

task one
  take law, like list, like text
  like text

  send back, <one>
`,
  },
  asCall,
)
ok('a list-typed take under a command compiles', listTake.ok, listTake.ok ? '' : listTake.diagnostics.map(d => d.message).join(' | '))
const lawTake = (listTake.ok ? listTake.program : [])
  .find((s): s is Dock => s.form === 'dock')
  ?.route.children.find(child => child.path === 'one')?.takes[0]
ok(
  'a list take is a repeatable option: list-typed, not positional, not variadic',
  lawTake?.type?.kind === 'array' && lawTake.positional === undefined && lawTake.variadic === undefined,
  JSON.stringify(lawTake),
)

const coded = refusals(`hook tool
  hook one
    slot x
      like text
      code s
    task one

task one
  take x, like text
  like text

  send back, read x
`)
ok('a slot with a code line is refused, not dropped', coded.some(m => m.includes('slot')), coded.join(' | '))

const taskSlot = compile(
  {
    file: '/gate/code/echo.tree',
    text: `task echo
  slot p, like text
  like text

  send back, read p
`,
  },
)
ok('a task\'s slot parameter still compiles', taskSlot.ok, taskSlot.ok ? '' : taskSlot.diagnostics.map(d => d.message).join(' | '))

// `mark pass` under a command (decision cli-in-term/008 part 2): the route says `passes`, in the JSON too, and the
// mark is not the command's help
const PASSING = `hook tool
  # Run another console
  hook zone
    mark pass
    # its words
    slot rest, like list, like text
    task zone
  hook other
    slot rest, like list, like text
    task zone

task zone
  take rest, like list, like text
  like text

  send back, <z>
`
const passing = compile({ file: '/gate/code/line/base.tree', text: PASSING }, asCall)
ok('a passing console compiles', passing.ok, passing.ok ? '' : passing.diagnostics.map(d => d.message).join(' | '))
const passingDock = (passing.ok ? passing.program : []).find((s): s is Dock => s.form === 'dock')
const zoneRoute = passingDock?.route.children.find(child => child.path === 'zone')
const otherRoute = passingDock?.route.children.find(child => child.path === 'other')
ok('mark pass sets passes on the route', zoneRoute?.passes === true, JSON.stringify(zoneRoute?.passes))
ok('a hook without the mark does not pass', otherRoute?.passes === undefined, JSON.stringify(otherRoute?.passes))
ok('the mark is not the help', zoneRoute?.note === 'Run another console', JSON.stringify(zoneRoute?.note))
const passingJson = passingDock ? statementJson(['span', 'type'], passingDock) : ''
ok('passes reaches the route JSON once', passingJson.split('"passes":true').length === 2, passingJson)

const passRefused = (body: string, want: string, name: string): void => {
  const found = refusals(`hook tool
  hook zone
    mark pass
${body}
    task zone

task zone
  take rest, like list, like text
  like text

  send back, <z>
`)
  ok(name, found.some(m => m.includes(want)), found.join(' | '))
}

passRefused('    slot rest, like list, like text\n    take quiet, like boolean', 'mark pass', 'a passing hook with a take is refused')
passRefused('    slot rest, like text', 'mark pass', 'a passing hook whose slot is not a list of text is refused')
passRefused('    slot rest, like list, like text\n    slot more, like list, like text', 'mark pass', 'a passing hook with two slots is refused')
passRefused('    slot rest, like list, like text\n    hook inner\n      task zone', 'mark pass', 'a passing hook with a nested hook is refused')

const otherMark = refusals(`hook tool
  hook zone
    mark async
    slot rest, like list, like text
    task zone

task zone
  take rest, like list, like text
  like text

  send back, <z>
`)
ok('another mark word under a command is refused', otherMark.some(m => m.includes('mark async')), otherMark.join(' | '))

const taskPass = refusals(`task zone
  mark pass
  like text

  send back, <z>
`)
ok('mark pass under a task is refused', taskPass.some(m => m.includes('mark pass')), taskPass.join(' | '))

const routePass = compile(
  {
    file: '/gate/code/site.tree',
    text: `hook /users
  mark pass
  task get
    send ok, <users>
`,
  },
  { roleOf: (): string => 'site' },
)
const routePassMessages = routePass.ok ? [] : routePass.diagnostics.map(d => d.message)
ok('mark pass under a URL route is refused', routePassMessages.some(m => m.includes('mark pass')), routePassMessages.join(' | '))

// A MAYBE TAKE OR SLOT CAN BE ABSENT (decision cli-in-term/008 part 1): its route keeps the whole `maybe` type with
// its item, and `need true`, a `bind` default or a maybe of a list is refused, naming the take
const maybeConsole = (lines: string, param: string): string => `load @term/base/maybe
  find maybe

hook tool
  hook hunt
${lines}
    task hunt

task hunt
  take ${param}
  like text

  send back, <z>
`
const maybeOk = compile({ file: `${process.cwd()}/test/compile/maybe-line.tree`, text: maybeConsole('    take runs\n      like maybe, like number\n    slot glob\n      like maybe, like text', 'runs, like maybe, like number\n  take glob, like maybe, like text') }, { ...asCall, resolve: projectResolver(process.cwd()) })
ok('a console of maybe takes compiles', maybeOk.ok, maybeOk.ok ? '' : maybeOk.diagnostics.map(d => d.message).join(' | '))
const maybeRoute = (maybeOk.ok ? maybeOk.program : []).find((s): s is Dock => s.form === 'dock')?.route.children[0]
const runsType = maybeRoute?.takes.find(take => take.name === 'runs')?.type
ok(
  'a maybe take keeps the maybe type with its item',
  JSON.stringify(runsType) === JSON.stringify({ kind: 'named', name: 'maybe', args: [{ kind: 'number' }] }),
  JSON.stringify(runsType),
)
ok('a maybe slot stays positional', maybeRoute?.takes.find(take => take.name === 'glob')?.positional === true)

const maybeRefused = (lines: string, param: string, want: string, name: string): void => {
  const found = refusals(maybeConsole(lines, param))
  ok(name, found.some(m => m.includes(want)), found.join(' | '))
}

maybeRefused('    take runs\n      like maybe, like number\n      need true', 'runs, like maybe, like number', '`runs` is a maybe', 'a maybe take with need true is refused')
maybeRefused('    take runs\n      like maybe, like number\n      bind code 3', 'runs, like maybe, like number', '`runs` is a maybe', 'a maybe take with a default is refused')
maybeRefused('    slot globs\n      like maybe, like list, like text', 'globs, like maybe, like list, like text', '`globs` is a maybe of a list', 'a maybe list slot is refused')

console.log(`\nhook-route: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
