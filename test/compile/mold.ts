// `term mold` and the other CLI verbs on a data file, through the built binary (host/line.js), so what a person
// types is what is tested: every form of `mold` on the fixtures, `look` listing keys, `form --check` accepting the
// canonical fixtures, `lint` reporting a broken one. Rebuild the binary first (see deck/term/CLAUDE.md).
// Run: npx tsx test/compile/mold.ts

import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

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

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const LINE = join(TERM, 'host/line.js')
const FIXTURE = 'deck/host/test/fixture'
const fixture = (name: string): string => readFileSync(join(TERM, FIXTURE, name), 'utf8')

if (!existsSync(LINE)) {
  console.log('FAIL  host/line.js is not built')
  process.exit(1)
}

function term(args: string[], stdin?: string): { code: number; out: string; err: string } {
  const run = spawnSync('node', [LINE, ...args], { cwd: TERM, input: stdin, encoding: 'utf8' })

  return { code: run.status ?? -1, out: run.stdout, err: run.stderr }
}

const at = (name: string): string => `${FIXTURE}/${name}`

// ---- mold ----

let run = term(['mold', at('basic.tree')])
ok('mold prints the long form', run.code === 0 && run.out === fixture('basic.tree'), run.out + run.err)

run = term(['mold', at('basic.line')])
ok('mold reads the compact form', run.code === 0 && run.out === fixture('basic.tree'), run.out + run.err)

run = term(['mold', at('basic.tree'), '--pack'])
ok('mold --pack prints the compact form', run.code === 0 && run.out === fixture('basic.line'), run.out + run.err)

run = term(['mold', at('basic.tree'), '--json'])
ok('mold --json prints JSON', run.code === 0 && run.out === fixture('basic.json'), run.out + run.err)

run = term(['mold', at('basic.json'), '--tree'])
ok('mold --tree reads JSON', run.code === 0 && run.out === fixture('basic.tree'), run.out + run.err)

run = term(['mold', at('basic.json')])
ok('a .json file is read as JSON without the flag', run.code === 0 && run.out === fixture('basic.tree'), run.out + run.err)

run = term(['mold', at('anchors.tree')])
ok(
  'mold expands anchors by default',
  run.code === 0 && run.out.includes('host env, <prod>') && !run.out.includes('fuse'),
  run.out + run.err,
)

run = term(['mold', at('anchors.tree'), '--trees'])
ok('mold --trees keeps them', run.code === 0 && run.out === fixture('anchors.tree'), run.out + run.err)

run = term(['mold', at('anchors.tree'), '--trees', '--pack'])
ok('mold --trees --pack packs them', run.code === 0 && run.out === fixture('anchors.line'), run.out + run.err)

run = term(['mold', at('bad/twice.tree'), '--check'])
ok('mold --check exits 1 on a broken file', run.code === 1 && run.err.includes('given twice'), run.out + run.err)

run = term(['mold', at('basic.tree'), '--check'])
ok('mold --check is silent on a clean file', run.code === 0 && run.out === '' && run.err === '', run.out + run.err)

run = term(['mold', at('stream.line'), '--lines'])
ok(
  'mold --lines expands a stream',
  run.code === 0 && run.out.includes('host prod-service\n    host config\n      host env, <prod>') && run.out.includes('host b, 123456'),
  run.out + run.err,
)

run = term(['mold', '--lines'], 'm(h(name,<foo>))\nm(h(name,<bar>))\n')
ok(
  'mold reads stdin',
  run.code === 0 && run.out === 'mesh\n  host name, <foo>\nmesh\n  host name, <bar>\n',
  run.out + run.err,
)

run = term(['mold', at('basic.tree'), '--json', '--keep'], undefined)
ok('mold --json --keep leaves keys alone', run.code === 0 && run.out === fixture('basic.json'), run.out)

run = term(['mold', '--json'], 'host retry-after, 3\n')
ok('mold --json turns a kebab key snake', run.code === 0 && run.out === '{"retry_after":3}\n', run.out + run.err)

// ---- look ----

run = term(['look', at('basic.tree')])
ok(
  'look lists the keys of a data file',
  run.code === 0 && run.out.includes('x/y/z') && run.out.includes('13 keys'),
  run.out + run.err,
)

run = term(['look', at('basic.tree'), '--json'])
ok('look --json prints the value', run.code === 0 && JSON.parse(run.out).x.y.z === 123, run.out + run.err)

run = term(['look', at('basic.tree'), '--csv'])
ok('look --csv prints a row per key', run.code === 0 && run.out.startsWith('path,kind,value\n') && run.out.includes('x/w,text,<foo>'), run.out + run.err)

// ---- form ----

run = term(['form', at('basic.tree'), at('anchors.tree'), at('basic.line'), '--check'])
ok('form --check accepts the canonical fixtures', run.code === 0, run.out + run.err)

run = term(['form', at('bad/twice.tree'), '--check'])
ok(
  'form refuses a broken data file and says why',
  run.code === 1 && run.err.includes('given twice') && run.err.includes('could not be read'),
  run.out + run.err,
)

// ---- lint ----

run = term(['lint', at('bad/twice.tree')])
ok('lint reports the grammar on a broken data file', run.code === 1 && run.err.includes('given twice') && run.err.includes('data-grammar'), run.out + run.err)

run = term(['lint', at('basic.tree')])
ok('lint is clean on a canonical data file', run.code === 0, run.out + run.err)

console.log(`\nmold: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
