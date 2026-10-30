// `digest-sha256-text` over a corpus (decision 080 of note/project/term/self-host/change/001-finish-self-host): every
// `.tree` text of deck/base through the node env's fast path (node:crypto) and the Term reference
// (native/shared/cryptography/sha256, the browser's path), both as the compiler emits them, and each also against
// node:crypto called here directly. Every text must give one digest three ways. Prints the count of texts, their
// characters and the differences. Run: npx tsx test/compile/digest-text-corpus.ts

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'

const ROOT = process.cwd()
const BASE = join(ROOT, 'deck/base')

function treesUnder(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)

    if (
      name === 'node_modules' ||
      name === 'host' ||
      name.startsWith('.')
    ) {
      continue
    }

    if (statSync(path).isDirectory()) {
      treesUnder(path, out)
    } else if (name.endsWith('.tree')) {
      out.push(path)
    }
  }

  return out
}

const PROGRAM = `load @term/base/native/shared/cryptography/sha256
  find calculate-sha256-text

load @term/base/cryptography/digest
  find digest-sha256-text

task both
  take value, like text
  like text
  save fast, call(digest-sha256-text, read(value))
  save reference, call(calculate-sha256-text, read(value))
  send back, text <{fast} {reference}>
`

const dir = mkdtempSync(join(tmpdir(), 'term-digest-corpus-'))
const source = join(dir, 'digest-corpus.tree')
writeFileSync(source, PROGRAM)
const result = compile(
  { file: source, text: PROGRAM },
  { resolve: projectResolver(ROOT, 'node'), env: 'node' },
)

if (!result.ok) {
  console.log(
    `FAIL  compile: ${[...new Set(result.diagnostics.map(d => d.message))].slice(0, 6).join(' | ')}`,
  )
  process.exit(1)
}

const files = treesUnder(BASE, [])
const list = join(dir, 'files.json')
writeFileSync(list, JSON.stringify(files))
const prelude = nativePrelude(
  result.program,
  'node',
  file => (existsSync(file) ? readFileSync(file, 'utf8') : undefined),
  result.typescript,
)
// the driver: each file's text through the emitted `both`, and node:crypto directly
const driver = `
import { readFileSync as __read } from 'node:fs'
import { createHash as __hash } from 'node:crypto'
const __files: string[] = JSON.parse(__read(${JSON.stringify(list)}, 'utf8'))
let __differ = 0
let __chars = 0
const __start = Date.now()
for (const __file of __files) {
  const __text = __read(__file, 'utf8')
  __chars += __text.length
  const [__fast, __reference] = String(both(__text)).split(' ')
  const __direct = __hash('sha256').update(__text).digest('hex')
  if (__fast !== __direct || __reference !== __direct) {
    __differ++
    if (__differ <= 5) console.log('DIFFER  ' + __file + '  fast ' + __fast + ' reference ' + __reference + ' node ' + __direct)
  }
}
console.log('texts ' + __files.length + ', characters ' + __chars + ', differ ' + __differ + ', ' + (Date.now() - __start) + ' ms')
if (__differ > 0) process.exit(1)
`
const file = join(dir, 'digest-corpus.ts')
writeFileSync(file, `${prelude}\n${result.typescript}\n${driver}\n`)
const run = spawnSync(process.execPath, ['--import', 'tsx', file], {
  encoding: 'utf8',
  maxBuffer: 1 << 26,
})
process.stdout.write(String(run.stdout))
process.stderr.write(String(run.stderr).slice(0, 2000))
console.log(
  `\ndigest-text-corpus: ${run.status === 0 ? 'pass' : 'FAIL'} (${createHash('sha256').update('').digest('hex').length / 2}-byte digests)`,
)
process.exit(run.status === 0 ? 0 : 1)
