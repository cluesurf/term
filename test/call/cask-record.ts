// A record across the cask bridge (native-dom-0019). The generator carries a record by value as host data text:
// `data-to-text(melt(value))` on the sending side, `fill(data-from-text(text))` on the receiving side, so both ends use
// the walker the compiler generates for the form and a field that is missing or of the wrong kind raises the named
// `data-mismatch` with its path. This test runs that exact code on TypeScript, and reads the generated bridge for the
// data cask to see `file/stat` carried rather than refused. The data cask itself (cask/data) runs it in a real cask.
// Run: npx tsx test/call/cask-record.ts

import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
import { generateBridge } from '@term/call/code/cask-generate'
import { nativePrelude } from '@term/make/code/compile/native'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'

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

const TERM = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '../..')

// the generator: file/stat crosses, as a record, through fill and melt
const report = generateBridge({ page: join(TERM, 'deck/cask/test/data/page.tree'), out: join(TERM, 'deck/cask/test/data'), commit: false })
ok('file/stat is carried, not refused', !report.refused.some(r => r.module === 'file' && r.task === 'stat'), JSON.stringify(report.refused))
ok('the bridge on disk is what the generator writes', report.drift.length === 0, JSON.stringify(report.drift))
const shim = readFileSync(join(TERM, 'deck/base/code/native/webview/file.tree'), 'utf8')
const statShim = shim.slice(shim.indexOf('task stat-file'), shim.indexOf('\ntask ', shim.indexOf('task stat-file') + 1))
ok('the page fills the reply into path-info', /call fill\n\s+call data-from-text[\s\S]*like path-info/.test(statShim), statShim)
const dispatch = readFileSync(join(TERM, 'deck/cask/test/data/dispatch.tree'), 'utf8')
ok('the cask melts its answer to text', /call data-to-text\n\s+call melt\n\s+read answer\n\s+like path-info/.test(dispatch))

// the converters, run: a round trip, and the named exception for a field that is missing or of the wrong kind
const PROGRAM = `load @term/host/code/text
  find data-from-text
  find data-to-text

load @term/base/code/file/stat
  find path-info

task carry
  take info, like path-info
  like text
  send back
    call data-to-text
      call melt
        read info
        like path-info

task land-info
  take text, like text
  like path-info
  send back
    call fill
      call data-from-text
        read text
      like path-info

task cross-and-back
  take size, like number
  like text
  save info
    make path-info
      bind size, read size
      bind directory, false
  save back
    call land-info
      call carry
        read info
  send back, text <{{back/size}} {{back/directory}}>
`

const file = join(TERM, 'test/call/cask-record.tree')
const result = compile({ file, text: PROGRAM }, { resolve: projectResolver(TERM, 'node'), env: 'node' })
ok('the converters compile', result.ok, result.ok ? '' : result.diagnostics.slice(0, 3).map(d => d.message).join(' | '))

if (result.ok) {
  const prelude = nativePrelude(result.program, 'node', path => (existsSync(path) ? readFileSync(path, 'utf8') : undefined))
  const js = transformSync(`${prelude}\n${result.typescript}`, { loader: 'ts', format: 'esm' }).code
  const out = join(mkdtempSync(join(tmpdir(), 'term-cask-record-')), 'record.mjs')
  writeFileSync(out, js)
  const mod = await import(pathToFileURL(out).href)

  ok('a path-info crosses and comes back whole', mod.crossAndBack(4096) === '4096 false', String(mod.crossAndBack(4096)))

  const refusal = (text: string): string => {
    try {
      mod.landInfo(text)
      return 'no exception'
    } catch (error) {
      const e = error as { form?: string; link?: { path?: string; reason?: string } }
      return `${e.form} ${e.link?.path} ${e.link?.reason}`
    }
  }

  ok('a missing field is the named data-mismatch, with its path', refusal('host size, 12\n') === 'data-mismatch directory is missing', refusal('host size, 12\n'))
  ok('a field of the wrong kind is named too', refusal('host size, <twelve>\nhost directory, false\n').startsWith('data-mismatch size '), refusal('host size, <twelve>\nhost directory, false\n'))
}

console.log(`\ncask-record: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
