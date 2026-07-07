// CSV stdlib test: compile the pure csv.tree module and run it on node, asserting RFC 4180 behavior end to end
// (quoted fields, embedded delimiters and newlines, doubled quotes, CRLF records, TSV via delimiter, and a
// stringify -> parse roundtrip). Run: npx tsx test/stdlib/csv.ts

import { compile } from '@cluesurf/make/code/compile/compile'
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { withNativeEnv } from '@cluesurf/make/code/compile/native'
import type { Source } from '@cluesurf/make/code/compile/load'

const baseTree = join(process.cwd(), 'deck', 'base')

const stdlib = (p: string): Source | undefined => {
  const pre = '@cluesurf/base/'

  if (!p.startsWith(pre)) {
    return undefined
  }

  const f = join(baseTree, `${p.slice(pre.length)}.tree`)

  return existsSync(f) ? { file: f, text: readFileSync(f, 'utf8') } : undefined
}

let pass = 0
let fail = 0

function eq(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)

  if (ok) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`,
    )
  }
}

async function main(): Promise<void> {
  const text = readFileSync('deck/base/code/csv.tree', 'utf8')
  const r = compile(
    { file: 'main.tree', text },
    { resolve: withNativeEnv('node', stdlib) },
  )

  if (!r.ok) {
    console.log(
      'FAIL compile',
      JSON.stringify(
        [...new Set(r.diagnostics.map(d => d.message))].slice(0, 5),
      ),
    )
    process.exit(1)
  }

  const dir = mkdtempSync(join(tmpdir(), 'csv-'))
  const f = join(dir, 'm.ts')
  writeFileSync(f, r.typescript)

  const m = (await import(pathToFileURL(f).href)) as {
    parse(input: string): string[][]
    parseWith(input: string, delimiter: string): string[][]
    stringify(rows: string[][]): string
    stringifyWith(rows: string[][], delimiter: string): string
  }

  eq('simple rows', m.parse('a,b,c\nd,e,f'), [
    ['a', 'b', 'c'],
    ['d', 'e', 'f'],
  ])
  eq('trailing newline adds no empty row', m.parse('a,b\n'), [['a', 'b']])
  eq('empty fields survive', m.parse('a,,c'), [['a', '', 'c']])
  eq('quoted field with delimiter', m.parse('a,"b,c",d'), [
    ['a', 'b,c', 'd'],
  ])
  eq('quoted field with newline', m.parse('a,"b\nc",d'), [
    ['a', 'b\nc', 'd'],
  ])
  eq('doubled quote is a literal quote', m.parse('a,"say ""hi""",b'), [
    ['a', 'say "hi"', 'b'],
  ])
  eq('CRLF records', m.parse('a,b\r\nc,d'), [
    ['a', 'b'],
    ['c', 'd'],
  ])
  eq('bare CR records', m.parse('a,b\rc,d'), [
    ['a', 'b'],
    ['c', 'd'],
  ])
  eq('TSV via delimiter', m.parseWith('a\tb\nc\td', '\t'), [
    ['a', 'b'],
    ['c', 'd'],
  ])
  eq('quoted empty field at record end', m.parse('a,""'), [['a', '']])

  eq('stringify plain', m.stringify([
    ['a', 'b'],
    ['c', 'd'],
  ]), 'a,b\nc,d')
  eq(
    'stringify quotes only when needed',
    m.stringify([['a,x', 'plain', 'say "hi"', 'line\nbreak']]),
    '"a,x",plain,"say ""hi""","line\nbreak"',
  )
  eq(
    'stringify TSV',
    m.stringifyWith(
      [
        ['a', 'b'],
        ['c', 'd'],
      ],
      '\t',
    ),
    'a\tb\nc\td',
  )

  // roundtrip: anything stringify writes, parse reads back exactly
  const rows = [
    ['name', 'note'],
    ['ada', 'says "hello", then\nleaves'],
    ['', 'trailing'],
  ]

  eq('roundtrip', m.parse(m.stringify(rows)), rows)

  console.log(`\ncsv: ${pass} pass, ${fail} fail`)

  if (fail) {
    process.exit(1)
  }
}

main()
