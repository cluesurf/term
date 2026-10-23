// A bind's text is host code written into its caller (compile/bind.tree render-bind), and two ways it went wrong
// compiled clean:
// - a `\n` (likewise `\r`, `\t`) in the text was unescaped by the text literal into a real line break, written inside
//   the JavaScript string: an unterminated string literal only tsx or esbuild loading the output refuses
//   (term-compiler-0047, work/boot/client-bundle.tree).
// - the text was spliced around its argument as written, so an argument that is not one primary lost its grouping:
//   `$value.trim()` over an awaited call emitted `await readIt().trim()`, the trim of a promise
//   (term-compiler-0046, work/registry/publishing.tree).
// Each case is built AND run. Run from deck/term/deck/term: npx tsx test/compile/bind-text.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'

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

const folder = mkdtempSync(join(tmpdir(), 'bind-text-'))
let count = 0

// compile one longhand file and run its `run` task, answering the TypeScript and what run gave back
async function build(text: string, ...args: unknown[]): Promise<{ typescript: string; answer?: unknown; failure?: string }> {
  const result = compile({ file: join(folder, 'main.tree'), text }, { leanOf: () => false } as never)

  if (!result.ok) {
    return { typescript: '', failure: `did not compile: ${result.diagnostics.map(d => d.message.split('\n')[0]).join(' | ')}` }
  }

  try {
    const js = transformSync(result.typescript, { loader: 'ts', format: 'esm' }).code
    const file = join(folder, `out-${count++}.mjs`)

    writeFileSync(file, js)

    const module = await import(pathToFileURL(file).href)

    return { typescript: result.typescript, answer: await module.run(...args) }
  } catch (error) {
    return { typescript: result.typescript, failure: String(error) }
  }
}

// 0047: the escapes a text literal turns into control characters stay escapes in a bind's text
const newline = await build(`bind joined
  take parts, like list, like text
  like text
  case node
    text <$parts.join("\\n")>

bind tabbed
  take parts, like list, like text
  like text
  case node
    text <$parts.join("\\t") + "\\r">

task run
  take parts, like list, like text
  like text
  save one
    call joined
      read parts
  save two
    call tabbed
      read parts
  send back, text <{one}{two}>
`, ['a', 'b'])

ok('a \\n in a bind text is the escape, never a line break', /join\("\\n"\)/.test(newline.typescript), newline.failure ?? newline.typescript.split('\n').filter(l => /join/.test(l)).join(' / '))
ok('the output loads and joins with a line break, a tab and a return', newline.answer === 'a\nba\tb\r', newline.failure ?? JSON.stringify(newline.answer))

// a doubled backslash still reaches the host as one (a regular expression's \s, 30 binds rely on it)
const regex = await build(`bind first-word
  take line, like text
  like text
  case node
    text <$line.trim().split(/\\\\s+/)[0]>

task run
  like text
  send back
    call first-word
      text < one two >
`)

ok('a doubled backslash is one backslash in the host', regex.answer === 'one', regex.failure ?? JSON.stringify(regex.answer))

// 0046: an argument that is not one primary is grouped where the text reads a member of it
const awaited = await build(`bind trim-text
  take value, like text
  like text
  case node
    text <$value.trim()>

task read-it
  like text
  mark async
  send back, text < x >

task run
  like text
  send back
    call trim-text
      call read-it
`)

ok('an awaited argument is grouped before .trim()', /\(await readIt\(\)\)\.trim\(\)/.test(awaited.typescript), awaited.typescript.split('\n').filter(l => /trim/.test(l)).join(' / '))
ok('it runs and trims the awaited text', awaited.answer === 'x', awaited.failure ?? JSON.stringify(awaited.answer))

// a binary argument under an operator of the text is grouped too; a delimited hole is left alone
const binary = await build(`bind shown
  take value, like boolean
  like text
  case node
    text <$value.toString()>

bind spelled
  take value, like boolean
  like text
  case node
    text <String($value)>

task run
  take a, like text
  like text
  save one
    call shown
      call is-equal
        read a
        text <x>
  save two
    call spelled
      call is-equal
        read a
        text <y>
  send back, text <{one}{two}>
`, 'x')

const lines = binary.typescript.split('\n').filter(l => /toString|String\(/.test(l)).join(' / ')

ok('a comparison before .toString() is grouped', /\(a === "x"\)\.toString\(\)/.test(binary.typescript), lines)
// the emitter groups a comparison itself; a hole between parentheses adds no group of its own
ok('a hole between parentheses is not grouped again', /String\(\(a === "y"\)\)/.test(binary.typescript), lines)
ok('it runs: "true" then "false"', binary.answer === 'truefalse', binary.failure ?? JSON.stringify(binary.answer))

// 0051: a hole the text uses twice reads its argument once. stdlibBase() ran twice through such a bind
const once = await build(`bind counted
  like number
  case node
    text <(globalThis.bindTextCount = (globalThis.bindTextCount ?? 0) + 1)>

bind doubled
  take value, like number
  like text
  case node
    text <String($value) + String($value)>

task run
  take a, like number
  like text
  save one
    call doubled
      call counted
  save two
    call doubled
      read a
  send back, text <{one}{two}>
`, 7)

ok('a call under a hole used twice runs once', once.answer === '1177', once.failure ?? JSON.stringify(once.answer))
ok('a plain name under it is pasted as is', /String\(a\) \+ String\(a\)/.test(once.typescript), once.typescript.split('\n').filter(l => /String\(/.test(l)).join(' / '))

// 0052: a parameter whose name starts with another's is its own hole, never the shorter one's with a tail
const prefix = await build(`bind paired
  take store, like text
  take stored, like text
  like text
  case node
    text <$stored + "/" + $store>

task run
  take a, like text
  take b, like text
  like text
  send back
    call paired
      read a
      read b
`, 'one', 'two')

ok('$stored is its own hole beside $store', prefix.answer === 'two/one', prefix.failure ?? JSON.stringify(prefix.answer))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
