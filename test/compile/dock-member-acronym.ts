// A kebab member of a `dock load` module whose segment after the first is an acronym word reads two ways:
// `host-module/to-json-value` was emitted `hostModule.toJSONValue`, while compile/host.ts exports `toJsonValue`, so the
// call was undefined at run time and the build was clean (term-compiler-0037, term-cli-in-term-0052). The build cannot
// see the host's exports, so such a member is refused as `dock-member-spelling`, naming both readings, on every backend
// (term/compiler decision 010). Written with no `-` it is the host's name as written, and a kebab member with no
// acronym word is still converted. Each output that builds is run against a real host module.
//
// Run: npx tsx test/compile/dock-member-acronym.ts (from deck/term/deck/term)

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

const dir = mkdtempSync(join(tmpdir(), 'term-dock-acronym-'))
const host = join(dir, 'host.mjs')
writeFileSync(
  host,
  'export function toJsonValue() { return "json" }\nexport function fileURLToPath() { return "url" }\nexport function readFileText() { return "text" }\n',
)
const dock = ['dock load', `  load <${pathToFileURL(host).href}>, name host-module`, '']

const task = (name: string, member: string): string[] => [`task ${name}`, '  like text', '  send back', `    call host-module/${member}`, '']

// the kebab spellings with an acronym word are refused, each naming both readings
for (const [member, upper, plain] of [
  ['to-json-value', 'toJSONValue', 'toJsonValue'],
  ['file-url-to-path', 'fileURLToPath', 'fileUrlToPath'],
] as const) {
  const result = compile({ file: 'main.tree', text: [...dock, ...task('one', member)].join('\n') }, { resolve: () => undefined })
  const said = result.ok ? 'built' : result.diagnostics.map(d => `${d.name} ${d.code} ${d.message}`).join(' | ')

  ok(`host-module/${member} is refused`, !result.ok, said)
  ok(`  as dock-member-spelling, an error`, !result.ok && result.diagnostics.some(d => d.name === 'dock-member-spelling' && d.code === 0x43 && d.severity === 'error'), said)
  ok(`  naming ${upper} and ${plain}`, !result.ok && result.diagnostics.some(d => d.message.includes(upper) && d.message.includes(plain)), said)
}

// the refusal is made before any backend: the same on rust, swift and kotlin
for (const env of ['rust', 'swift', 'kotlin'] as const) {
  const result = compile({ file: 'main.tree', text: [...dock, ...task('one', 'to-json-value')].join('\n') }, { resolve: () => undefined, env })

  ok(`refused on ${env}`, !result.ok && result.diagnostics.some(d => d.name === 'dock-member-spelling'), result.ok ? 'built' : result.diagnostics[0]?.message)
}

// a lean call of the same member is refused too
{
  const text = [...dock, 'task one', '  like text', '  back host-module/to-json-value()', ''].join('\n')
  const result = compile({ file: 'main.tree', text }, { resolve: () => undefined })

  ok('a lean host-module/to-json-value() is refused', !result.ok && result.diagnostics.some(d => d.message.includes('toJSONValue')), result.ok ? 'built' : result.diagnostics[0]?.message)
}

// the host's own spelling is written as is, and a kebab member with no acronym word is converted
const main = [...dock, ...task('json', 'toJsonValue'), ...task('url', 'fileURLToPath'), ...task('text', 'read-file-text')].join('\n')
const result = compile({ file: 'main.tree', text: main }, { resolve: () => undefined })
const said = result.ok ? result.typescript : result.diagnostics.map(d => d.message).join(' | ')

ok('host/toJsonValue, host/fileURLToPath and host/read-file-text build', result.ok, said)

if (result.ok) {
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(result.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as Record<string, () => unknown>
  const run = (name: string): unknown => {
    try {
      return mod[name]?.()
    } catch (error) {
      return (error as Error).message
    }
  }

  ok('toJsonValue reaches the export', run('json') === 'json', String(run('json')))
  ok('fileURLToPath reaches the export', run('url') === 'url', String(run('url')))
  ok('read-file-text is still converted to readFileText', run('text') === 'text', String(run('text')))
}

// a local named like the dock hides it, so a member of the local is a field, never refused
{
  const text = [
    ...dock,
    'form holder',
    '  link to-json-value, like text',
    '',
    'task one',
    '  like text',
    '  save host-module',
    '    make holder',
    '      bind to-json-value, text <x>',
    '  send back, read host-module/to-json-value',
    '',
  ].join('\n')
  const hidden = compile({ file: 'main.tree', text }, { resolve: () => undefined })

  ok('a field of a local named like the dock is not refused', hidden.ok || !hidden.diagnostics.some(d => /could be/.test(d.message)), hidden.ok ? '' : hidden.diagnostics.map(d => d.message).join(' | '))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
