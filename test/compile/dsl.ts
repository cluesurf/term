// Tests that the mill lowers the zone (component) and dock (routing/CLI) DSL surfaces to the compile AST.
// Run: npx tsx test/compile/dsl.ts

import { parse } from '@/code/parser/tree'
import { mill } from '@/code/compile/mill'
import type { Program, Statement } from '@/code/compile/node'

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
    throw new Error('parse: ' + JSON.stringify(parsed.diagnostics))
  const milled = mill(parsed.tree, 't.tree')
  if (!milled.ok)
    throw new Error('mill: ' + JSON.stringify(milled.diagnostics))
  return milled.program
}

function main(): void {
  // a zone component lowers to a `zone` statement with params and a body
  {
    const program = lower(
      `zone counter\n  take label, like text\n  zone div\n    read app/count\n`,
    )
    const zone = program.find(
      (s): s is Extract<Statement, { form: 'zone' }> =>
        s.form === 'zone',
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
      `dock /users\n  task get\n    call list-users\n  task post\n    call make-user\n`,
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
      `dock make\n  take name\n    like text\n    need true\n  call make-deck\n    bind name, read name\n`,
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

  // a client route lowers to a dock that renders a zone component
  {
    const program = lower(
      `dock /counter\n  zone counter\n    bind label, text <hits>\n`,
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
