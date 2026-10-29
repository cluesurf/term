// A member read off a `dock load` module is the host's own spelling when it holds no `-`. The kebab-to-camel
// conversion dropped the underscores of an UPPER_SNAKE member, so `hunt-module/HUNT_FUZZ_CHILD` emitted
// `huntModule.HUNTFUZZCHILD`: undefined at run time, and the build was clean (term-compiler-0033). A kebab member
// (`read-word`) is still converted. Each output is run against a real host module.
//
// Run: npx tsx test/compile/dock-member-snake.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'

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

const dir = mkdtempSync(join(tmpdir(), 'term-dock-member-'))
const host = join(dir, 'host.mjs')
writeFileSync(
  host,
  'export const HUNT_FUZZ_CHILD = "__child"\nexport const FOO = "foo"\nexport const snake_case_member = 7\nexport function readWord() { return "word" }\nexport function MAKE_IT() { return "made" }\n',
)

const main = [
  'dock load',
  `  load <${pathToFileURL(host).href}>, name hunt-module`,
  '',
  'task child',
  '  like text',
  '  send back, read hunt-module/HUNT_FUZZ_CHILD',
  '',
  'task foo',
  '  like text',
  '  send back, read hunt-module/FOO',
  '',
  'task snake',
  '  like number',
  '  send back, read hunt-module/snake_case_member',
  '',
  'task word',
  '  like text',
  '  send back',
  '    call hunt-module/read-word',
  '',
  'task made',
  '  like text',
  '  send back',
  '    call hunt-module/MAKE_IT',
  '',
].join('\n')

const result = compile(
  { file: 'main.tree', text: main },
  { resolve: () => undefined },
)
const said = result.ok
  ? result.typescript
  : result.diagnostics.map(d => d.message).join(' | ')
ok(
  'a dock module read by UPPER_SNAKE members compiles',
  result.ok,
  said,
)

if (result.ok) {
  ok(
    'the member keeps its underscores',
    /\.HUNT_FUZZ_CHILD\b/.test(result.typescript),
    said,
  )

  const file = join(dir, 'module.mjs')
  writeFileSync(
    file,
    transformSync(result.typescript, { loader: 'ts', format: 'esm' })
      .code,
  )
  const mod = (await import(pathToFileURL(file).href)) as Record<
    string,
    () => unknown
  >

  ok(
    'HUNT_FUZZ_CHILD reads the host value',
    mod.child?.() === '__child',
    String(mod.child?.()),
  )
  ok(
    'FOO reads the host value',
    mod.foo?.() === 'foo',
    String(mod.foo?.()),
  )
  ok(
    'a snake_case member reads the host value',
    mod.snake?.() === 7,
    String(mod.snake?.()),
  )
  ok(
    'a kebab member is still converted (read-word is readWord)',
    mod.word?.() === 'word',
    String(mod.word?.()),
  )
  ok(
    'an UPPER_SNAKE callee is called as written',
    mod.made?.() === 'made',
    String(mod.made?.()),
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
