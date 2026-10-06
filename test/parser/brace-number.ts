// A whole number in braces in a text literal is a value (parser/token.ts and token.tree, `TEXT_PATTERN`): `<{123}>` is
// `123`, as `{x}` is the value of `x`. It printed the braces until 2026-10-05, with no message. A regex quantifier with
// a comma and a brace before anything else stay text, and in a path a literal index is still a plain segment.
// Run: npx tsx test/parser/brace-number.ts

import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'

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

// the text a task answers on TypeScript, run in place
const answer = async (body: string): Promise<string> => {
  const result = compile({ file: '/tmp/brace-number.tree', text: `task run\n  like text\n  back ${body}\n` }, { resolve: stdlibResolver() })

  if (!result.ok) {
    return `did not compile: ${result.diagnostics.map(d => d.message).join(' | ')}`
  }

  const { transformSync } = await import('esbuild')
  const js = transformSync(result.typescript.replace(/^export /gm, ''), { loader: 'ts' }).code

  return String(new Function(`${js}\nreturn run()`)())
}

ok('a number alone in braces is its value', (await answer('<{123}>')) === '123', await answer('<{123}>'))
ok('beside text', (await answer('<a {31} b>')) === 'a 31 b', await answer('<a {31} b>'))
ok('a negative one', (await answer('<at {-7}>')) === 'at -7', await answer('<at {-7}>'))
ok('a quantifier with a comma stays text', (await answer('<[0-9]{3,5}>')) === '[0-9]{3,5}', await answer('<[0-9]{3,5}>'))
ok('JSON stays text', (await answer('<{"a":1}>')) === '{"a":1}', await answer('<{"a":1}>'))
ok('an escaped brace is a brace', (await answer('<\\{3\\}>')) === '{3}', await answer('<\\{3\\}>'))
ok('a name in braces is still its value', (await answer('<{add(1, 2)}>')) === '3', await answer('<{add(1, 2)}>'))
// a number in braces right after another character is a quantifier, as written: a uuid pattern matched `[0-9a-f]8`
// until this held, on every backend (token.tree `stands-apart`, 2026-10-05)
ok('a quantifier after a class stays text', (await answer('<^[0-9a-f]{8}$>')) === '^[0-9a-f]{8}$', await answer('<^[0-9a-f]{8}$>'))
ok('after an escape', (await answer('<\\d{4}>')) === '\\d{4}', await answer('<\\d{4}>'))
ok('after a letter or a group', (await answer('<a{2}(ab){3}>')) === 'a{2}(ab){3}', await answer('<a{2}(ab){3}>'))
ok('after another interpolation it is a value', (await answer('<{add(1, 2)}{4}>')) === '34', await answer('<{add(1, 2)}{4}>'))

console.log(`\nbrace-number: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
