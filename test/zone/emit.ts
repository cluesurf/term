// Tests the zone/dock emit: mill the DSL surface to AST, emit it back to `.tree` (the render-runtime call shape),
// and confirm the emitted source parses and contains the expected runtime calls. Run: npx tsx test/zone/emit.ts

import { parse } from '@cluesurf/make/code/parser/tree'
import { mill } from '@cluesurf/make/code/compile/mill'
import {
  emitZoneTree,
  emitDockTree,
} from '@cluesurf/make/code/zone/tree'
import type { Statement } from '@cluesurf/make/code/compile/node'

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

function lower(text: string): Array<Statement> {
  const parsed = parse({ file: 't.tree', text })
  if (!parsed.ok)
    throw new Error('parse: ' + JSON.stringify(parsed.diagnostics))
  const milled = mill(parsed.tree, 't.tree')
  if (!milled.ok)
    throw new Error('mill: ' + JSON.stringify(milled.diagnostics))
  return milled.program
}

const parses = (text: string): boolean =>
  parse({ file: 'emit.tree', text }).ok

function main(): void {
  // a zone emits a build task that calls the render runtime, and the output re-parses
  {
    const program = lower(
      `zone counter\n  take label, like text\n  zone div\n    seed class, text <c>\n    zone button\n      seed click, call add\n      text <go>\n    read app/count\n    fork test\n      hook test\n        call is-above\n          read app/count\n          code 10\n      hook hold\n        text <high>\n      hook miss\n        text <low>\n`,
    )
    const zone = program.find(
      (s): s is Extract<Statement, { form: 'zone' }> =>
        s.form === 'zone',
    )!
    const out = emitZoneTree(zone)
    ok('zone emit re-parses', parses(out), out)
    ok('zone emit builds an element', out.includes('call element'))
    ok('zone emit binds an attribute', out.includes('call attribute'))
    ok('zone emit wires an event', out.includes('call event'))
    ok('zone emit makes a dynamic text', out.includes('call dynamic'))
    ok('zone emit lowers fork to show', out.includes('call show'))
    ok('zone emit is a build task', out.startsWith('task counter'))
  }

  // a server route emits a route descriptor with its methods
  {
    const program = lower(
      `dock /users\n  task get\n    call list-users\n  task post\n    call make-user\n`,
    )
    const dock = program.find(
      (s): s is Extract<Statement, { form: 'dock' }> =>
        s.form === 'dock',
    )!
    const out = emitDockTree(dock)
    ok('dock emit re-parses', parses(out), out)
    ok(
      'dock emit carries the path',
      out.includes('bind path, text </users>'),
    )
    ok(
      'dock emit carries methods',
      out.includes('text <get>') && out.includes('text <post>'),
    )
    ok(
      'dock emit carries the handler',
      out.includes('text <list-users>'),
    )
  }

  // a client route emits a descriptor mapping the path to a component
  {
    const program = lower(`dock /counter\n  zone counter\n`)
    const dock = program.find(
      (s): s is Extract<Statement, { form: 'dock' }> =>
        s.form === 'dock',
    )!
    ok(
      'client route emit maps to a zone',
      emitDockTree(dock).includes('bind zone, text <counter>'),
    )
  }

  console.log(`\nzone-emit: ${pass} pass, ${fail} fail`)
}

main()
