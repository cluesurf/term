// Three shapes a generated grammar table has (mesh grammar/v4, 2026-10-13), built by the CLI itself on a small lean
// package in a temporary directory, merged and separate:
//
// 1. A LONG LITERAL IS ONE ITEM PER LINE (compile/ts-emit.tree `join-items`). An array, Map or record whose one-line
//    form passes 1,000 characters is broken per item, so no table is one giant line: tsgo's source-map writer is
//    quadratic in line length and took over sixteen minutes on a 2.8-million-character one. A short literal keeps its
//    exact one-line spelling.
// 2. A LEAN CONSTRUCTION OF A FORM SPLIT BY FILE (check/scope.ts `rewrite`). `pair feature(<a>), value <b>` of the
//    package's own `pair`, in a file that also loads @term/base/list (which loads @term/base/pair's `pair`), was
//    `the name "pair" is not defined`: binding by import renamed both forms and left the lean call's callee alone.
// 3. A TOP-LEVEL VALUE NAMED LIKE A FORM, in a hold (check/elaborate.ts `kindsApart`). `host non-finite` is a list of
//    the form `non-finite`, and `size(non-finite)` in a `want hold` found the form on the kernel's copy:
//    `kernel: type mismatch: expected (Array ?), found Type 0`.
//
// Run: npx tsx test/compile/table-shapes.ts (after `pnpm run make:line`: it runs host/line.js)

import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LINE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../host/line.js',
)

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

const rows: string[] = []

for (let i = 0; i < 200; i++) {
  rows.push(`  row name(<row-${i}>), tags <t${i}>`)
}

const files: Record<string, string> = {
  'deck.tree':
    'deck @gate/table-shapes\n  mark <0.0.1>\n  link @term/base, mark <0.0.x>\n  test ./test\n',
  'base/role.tree':
    'load @term/code\n  find code\n\nrole code\n  mark lean\n  take @/code/**/*.tree\n',
  'code/shape.tree': [
    'load @term/base/list',
    '  find list',
    '',
    'form row',
    '  link name, like text',
    '  link tags, like list, like text',
    '',
    'form pair',
    '  link feature, like text',
    '  link value, like text',
    '',
    'form non-finite',
    '  link key, like text',
    '',
    'host short',
    '  like list',
    '    like text',
    '  <a>',
    '  <b>',
    '',
    'host rows',
    '  like list',
    '    like row',
    ...rows,
    '',
    'host non-finite',
    '  like list',
    '    like non-finite',
    '  non-finite key <a>',
    '  non-finite key <b>',
    '',
  ].join('\n'),
  'code/use.tree': [
    'load ./shape',
    '  find pair',
    '',
    'load @term/base/list',
    '  find list',
    '  find push',
    '',
    'task pairs',
    '  like list, like pair',
    '  save made',
    '    make list',
    '  call push',
    '    bind list, read made',
    '    bind item',
    '      pair feature(<class>), value <stem>',
    '  back made',
    '',
  ].join('\n'),
  'test/shape.tree': [
    'load ../code/shape',
    '  find non-finite',
    '',
    'load @term/base/list',
    '  find size',
    '',
    'test two-rows',
    '  want hold',
    '    is-equal size(non-finite), 2',
    '',
  ].join('\n'),
}

for (const mode of ['--merged', '--separate']) {
  const dir = mkdtempSync(join(tmpdir(), 'term-table-shapes-'))

  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }

  const run = spawnSync(
    process.execPath,
    [LINE, 'make', mode, '--plain', '--color', 'never'],
    { cwd: dir, encoding: 'utf8' },
  )
  const said = `${run.stdout}${run.stderr}`
  ok(
    `${mode}: the package builds`,
    run.status === 0,
    said
      .split('\n')
      .filter(l => l.startsWith('failed'))
      .join(' | ') || said.slice(-600),
  )

  if (run.status !== 0) {
    continue
  }

  const shape = readFileSync(join(dir, 'host/code/shape.ts'), 'utf8')
  const units =
    mode === '--separate'
      ? readFileSync(
          join(dir, 'host/.unit/_gate_table-shapes_code_shape.ts'),
          'utf8',
        )
      : shape
  const longest = Math.max(
    ...units.split('\n').map(line => line.length),
  )
  ok(
    `${mode}: no line of the 200-row table passes 1,000 characters`,
    longest <= 1000,
    `longest ${longest}`,
  )
  ok(
    `${mode}: one row per line`,
    units.includes('\n{ name: "row-1", tags: ["t1"] },\n'),
  )
  ok(
    `${mode}: a short list keeps its one-line spelling`,
    units.includes('= ["a", "b"]'),
  )
}

console.log(`\ntable-shapes: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
