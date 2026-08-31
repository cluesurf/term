// Tests that the mill lowers the view (component) and hook (routing/CLI) DSL surfaces to the compile AST.
//
// `dock` was a second spelling of a route and was retired on 2026-08-31: it is the native FFI binding now
// (`dock load`, `dock type`) and nothing else. A route and a CLI command are both `hook`.
// Run: npx tsx test/compile/dsl.ts

import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import type {
  Program,
  Statement,
} from '@term/make/code/compile/node'

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

function lower(text: string): Program {
  const parsed = parse({ file: 't.tree', text })

  if (!parsed.ok)
    {throw new Error('parse: ' + JSON.stringify(parsed.diagnostics))}

  const milled = mill(parsed.tree, 't.tree')

  if (!milled.ok)
    {throw new Error('mill: ' + JSON.stringify(milled.diagnostics))}

  return milled.program
}

function main(): void {
  // a zone component lowers to a `zone` statement with params and a body
  {
    const program = lower(
      `view counter\n  take label, like text\n  view div\n    read app/count\n`,
    )

    const zone = program.find(
      (s): s is Extract<Statement, { form: 'view' }> =>
        s.form === 'view',
    )

    ok('zone lowers to a zone statement', zone !== undefined)
    ok('zone keeps its name', zone?.name === 'counter')
    ok('zone keeps its params', zone?.params[0]?.name === 'label')
    ok('zone body is an element', zone?.body[0]?.form === 'element')

    const element = zone?.body[0]
    ok(
      'element nests a read child',
      element?.form === 'element' &&
        element.children[0]?.form === 'read',
    )
  }

  // a server route lowers to a `dock` with HTTP method handlers
  {
    const program = lower(
      `hook /users\n  task get\n    call list-users\n  task post\n    call make-user\n`,
    )

    const dock = program.find(
      (s): s is Extract<Statement, { form: 'dock' }> =>
        s.form === 'dock',
    )

    ok('server route lowers to a dock', dock !== undefined)
    ok('dock keeps its path', dock?.route.path === '/users')
    ok(
      'dock collects methods',
      JSON.stringify(dock?.route.methods.map(m => m.name)) ===
        '["get","post"]',
    )
    ok(
      'method collects its call',
      dock?.route.methods[0]?.calls[0]?.name === 'list-users',
    )
  }

  // a CLI command lowers to a dock with options and a handler
  {
    const program = lower(
      `hook make\n  take name\n    like text\n    need true\n  call make-deck\n    bind name, read name\n`,
    )

    const dock = program.find(
      (s): s is Extract<Statement, { form: 'dock' }> =>
        s.form === 'dock',
    )

    ok('CLI command lowers to a dock', dock?.route.path === 'make')
    ok('dock collects options', dock?.route.takes[0]?.name === 'name')
    ok(
      'option requiredness is captured',
      dock?.route.takes[0]?.required === true,
    )
    ok(
      'dock collects the handler call',
      dock?.route.calls[0]?.name === 'make-deck',
    )
  }

  // A COMMAND'S HANDLER, both spellings. `task <impl>` names it and passes the takes in order (the zone console
  // uses this throughout); `call <impl>` with `bind` children names it and binds its arguments. Only `task` was
  // read, so a `call` handler was DROPPED without a word: the command lowered with an empty `calls` list,
  // compiled clean, and had nothing to run. Invisible while such a command was still spelled `dock make`, which
  // went down the route builder instead.
  {
    const withCall = lower(
      `hook one\n  take name\n    like text\n  call run-it\n    bind name, read name\n`,
    )
    const withTask = lower(`hook two\n  take name\n    like text\n  task run-it\n`)
    const routeOf = (program: Statement[]): { calls: { name: string; args: unknown[] }[] } | undefined =>
      (program.find((s): s is Extract<Statement, { form: 'dock' }> => s.form === 'dock') as
        | { route: { calls: { name: string; args: unknown[] }[] } }
        | undefined)?.route

    ok('a `call` handler is collected', routeOf(withCall)?.calls[0]?.name === 'run-it')
    ok('and its bound arguments come with it', (routeOf(withCall)?.calls[0]?.args.length ?? 0) === 1)
    ok('a `task` handler is collected', routeOf(withTask)?.calls[0]?.name === 'run-it')
  }

  // a CLI command tree in the `hook` DSL lowers to a route: command name, its takes, the bound implementation task,
  // and nested subcommands
  {
    const program = lower(
      `hook make\n  take name\n  task make-deck\n  hook face\n    take name\n    task make-face\n`,
    )

    const hook = program.find(
      (s): s is Extract<Statement, { form: 'dock' }> =>
        s.form === 'dock' && s.route.path === 'make',
    )

    ok('hook command lowers to a route', hook !== undefined)
    ok('hook keeps the command name', hook?.route.path === 'make')
    ok('hook collects its takes', hook?.route.takes[0]?.name === 'name')
    ok(
      'hook binds the implementation task',
      hook?.route.calls[0]?.name === 'make-deck',
    )
    ok(
      'hook nests subcommands',
      hook?.route.children[0]?.path === 'face' &&
        hook?.route.children[0]?.calls[0]?.name === 'make-face',
    )
  }

  // a client route lowers to a dock that renders a zone component
  {
    const program = lower(
      `hook /counter\n  view counter\n    bind label, text <hits>\n`,
    )

    const dock = program.find(
      (s): s is Extract<Statement, { form: 'dock' }> =>
        s.form === 'dock',
    )

    ok(
      'client route maps to a component',
      dock?.route.component?.name === 'counter',
    )
    ok(
      'component prop is captured',
      dock?.route.component?.props[0]?.name === 'label',
    )
  }

  // `dock load` still lowers to a native FFI binding (not a route)
  {
    const program = lower(`dock load\n  load <node:fs>, name fs\n`)
    ok(
      'dock load stays native FFI',
      program.some(s => s.form === 'native'),
    )
    ok(
      'dock load is not a route',
      !program.some(s => s.form === 'dock'),
    )
  }

  console.log(`\ndsl: ${pass} pass, ${fail} fail`)
}

main()
