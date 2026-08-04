/**
 * The `seed hunt` CLI in the native `.tree` hook DSL, end to end. Run:
 *   npx tsx deck/test/code/demo-hook-cli.ts
 *
 * Compiles fixture/hunt-cli.tree (a `hook` command using the extended
 * DSL: note / bind / typed takes), pulls the lowered DockRoute out of the
 * compiled program, and runs the real `dispatch` over sample argv -
 * proving the .tree -> route -> dispatch path: help text carries through,
 * defaults fill in, types coerce, and `--no-` negates. This is the CLI
 * surface moving off hand-written yargs onto the language itself
 * (note/seed/cli-hook-dsl-gaps.md).
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '@term/make/code/compile/compile'
import { commandRoutes, dispatch, renderHelp } from '@term/call/code/hook-dispatch'

const HERE = path.dirname(fileURLToPath(import.meta.url))

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

const file = path.join(HERE, 'fixture', 'hunt-cli.tree')
const compiled = compile({ file, text: readFileSync(file, 'utf8') }, { resolve: () => undefined })

ok('the .tree hook command compiles', compiled.ok)
if (!compiled.ok) {
  console.log(compiled.diagnostics.slice(0, 3))
  console.log(`\nseed-verify hook-cli demo: ${pass} pass, 1 fail`)
  process.exit(1)
}

const routes = commandRoutes(compiled.program)
const hunt = routes.find(r => r.path === 'hunt')
ok('the hunt route lowered from the DSL', hunt !== undefined)
if (!hunt) { console.log('\nseed-verify hook-cli demo: FAIL'); process.exit(1) }

// the extended DSL fields carried through the mill
ok('command help (note) lowered', hunt.note === 'Automated bug-hunt over .tree files')
ok('bound task lowered', hunt.calls[0]?.name === 'call-hunt' || hunt.calls[0]?.name === 'callHunt')
const runs = hunt.takes.find(t => t.name === 'runs')
ok('take help (note) lowered', runs?.note === 'Fuzz inputs per seed')
ok('take default (bind) lowered', runs?.fallback === 3000)
ok('take type lowered', runs?.type?.kind === 'number')

// dispatch: defaults fill in, types coerce, --no- negates
const d1 = dispatch(routes, ['hunt', 'deck/base/code'])
ok('dispatch resolves the command + bound task', d1.ok && d1.command[0] === 'hunt' && !!d1.task)
ok('positional binds to glob', d1.ok && d1.args.glob === 'deck/base/code')
ok('defaults fill missing flags', d1.ok && d1.args.runs === 3000 && d1.args.seeds === 4 && d1.args['fuzz-timeout'] === 90)

const d2 = dispatch(routes, ['hunt', '--runs', '500', '--seeds', '2'])
ok('explicit number flag coerces + overrides default', d2.ok && d2.args.runs === 500 && d2.args.seeds === 2)

const d3 = dispatch(routes, ['hunt', '--json'])
ok('boolean flag sets true', d3.ok && d3.args.json === true)

const d4 = dispatch(routes, ['hunt', '--no-json'])
ok('--no- negates a boolean', d4.ok && d4.args.json === false)

// help renders from the route
const help = renderHelp(hunt)
ok('renderHelp includes the command note and option help',
  help.includes('Automated bug-hunt') && help.includes('Fuzz inputs per seed') && help.includes('default 3000'))
console.log('\n  --- seed hunt --help (generated from the .tree) ---')
console.log(help.split('\n').map(l => '  ' + l).join('\n'))

console.log(`\nseed-verify hook-cli demo: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
