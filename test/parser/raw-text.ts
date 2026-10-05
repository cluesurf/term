// The raw text literal, `<<...>>` (parser/token.ts): its content is read exactly as written, up to the `>>` that ends
// the first run of `>` on its line, with no interpolation and no escape, so a pattern reads as its engine reads it.
// Held here: the VALUE each spelling compiles to (run on TypeScript), the refusal of one left open, what a printer
// writes back (the raw spelling, and never an accidental `<<` for an ordinary literal), and that `<<` inside an
// ordinary literal is still content. Decided 2026-10-04 (note/term/stdlib/regex-engine.md, "Writing a pattern").
// Run: npx tsx test/parser/raw-text.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { parse, printTree } from '@term/make/code/parser/tree'
import { format } from '@term/make/code/format/format'

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

// each literal as written, and the text it must mean
const CASES: [string, string][] = [
  ['<<\\p{Lu}\\p{Ll}+>>', '\\p{Lu}\\p{Ll}+'],
  ['<<(?<=\\$)\\d+>>', '(?<=\\$)\\d+'],
  ['<<a\\nb>>', 'a\\nb'],
  ['<<{x} and {{y}}>>', '{x} and {{y}}'],
  ['<<a < b > c>>', 'a < b > c'],
  ['<<<.+?>>>', '<.+?>'],
  ['<<<a>,<bb>>>', '<a>,<bb>'],
  ['<<>>', ''],
  ['<\\<x\\>>', '<x>'],
  ['<a<<b>>c>', 'a<<b>>c'],
]

async function main(): Promise<void> {
  const source = CASES.map(([literal], i) => `task case-${i}\n  like text\n  send back, text ${literal}\n`).join('\n') +
    `\ntask pair\n  take a, like text\n  take b, like text\n  like text\n  send back, text <{a}{b}>\n` +
    `\ntask both\n  like text\n  save joined, call pair(text(<<a>>), text(<<b>>))\n  send back, read joined\n`
  const result = compile({ file: 'raw.tree', text: source })
  ok('every spelling compiles', result.ok, result.ok ? '' : result.diagnostics.map(d => d.message).join(' | '))

  if (result.ok) {
    const dir = mkdtempSync(join(tmpdir(), 'term-raw-text-'))
    const file = join(dir, 'raw.mjs')
    writeFileSync(file, transformSync(result.typescript, { loader: 'ts', format: 'esm' }).code)
    const mod = await import(pathToFileURL(file).href)

    CASES.forEach(([literal, want], i) => {
      const got = mod[`case${i}`]()
      ok(`${literal} means ${JSON.stringify(want)}`, got === want, JSON.stringify(got))
    })

    ok('two raw literals on one line close apart', mod.both() === 'ab', JSON.stringify(mod.both()))
  }

  const open = parse({ file: 'open.tree', text: 'task x\n  send back, text <<abc>\n' })
  ok(
    'a raw literal left open is refused on its line',
    !open.ok && open.diagnostics.some(d => (d.message ?? '').includes('must end with `>>`')),
    open.ok ? 'parsed' : open.diagnostics.map(d => d.message).join(' | '),
  )

  // a printer writes a raw literal back raw, and an ordinary literal opening with an angle never as `<<`
  for (const [literal] of CASES) {
    const text = `save x, text ${literal}\n`
    const parsed = parse({ file: 'print.tree', text })

    if (!parsed.ok) {
      ok(`${literal} parses`, false, parsed.diagnostics.map(d => d.message).join(' | '))
      continue
    }

    const printed = printTree(parsed.tree)
    const formatted = format({ file: 'print.tree', text })
    const raw = literal.startsWith('<<')

    ok(`${literal} prints back ${raw ? 'raw' : 'without a leading <<'}`, raw ? printed.includes(literal) : !printed.includes('<<x') && printed.includes(literal), printed.trim())
    ok(`${literal} formats back the same`, formatted === text, formatted.trim())
  }
}

await main()
console.log(`\nraw-text: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
