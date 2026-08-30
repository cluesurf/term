// Proof for the feed mill compiler (deck/make/code/compile/feed-mill.ts): reads a real, shipped mine.tree
// grammar, generates .tree source implementing its reader from the grammar ALONE, compiles it through the
// ordinary parse/mill/check pipeline, and checks its output against the same fixed fixtures the hand-written
// reader already passes in deck/feed/test/*.tree. Run: npx tsx test/compile/feed-mill-run.ts

import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import { resolve as resolveNames } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { resolveAsync } from '@term/make/code/check/async-resolve'
import { simplify } from '@term/make/code/ir/simplify'
import { collectModules } from '@term/make/code/compile/load'
import type { Source } from '@term/make/code/compile/load'
import { withNativeEnv, nativePrelude } from '@term/make/code/compile/native'
import { expandTemplates } from '@term/make/code/compile/template'
import { extendForms } from '@term/make/code/check/extend'
import { disambiguateOverloads } from '@term/make/code/check/overload'
import { emitTypeScript } from '@term/make/code/compile/typescript'
import type { Program } from '@term/make/code/compile/node'
import { readFeedMineGrammar, compileFeedMine } from '@term/make/code/compile/feed-mill'
import type { Substrate } from '@term/make/code/compile/feed-mill'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info.slice(0, 800)}`)
  }
}

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const PACKS: Record<string, string> = { seed: join(TERM, 'deck/seed'), feed: join(TERM, 'deck/feed') }

const resolver = (path: string, from: string): Source | undefined => {
  if (path.startsWith('./') || path.startsWith('../')) {
    const base = join(from.replace(/\/[^/]*$/, ''), path)

    for (const file of [`${base}.tree`, join(base, 'base.tree')]) {
      if (existsSync(file)) {
        return { file, text: readFileSync(file, 'utf8') }
      }
    }

    return undefined
  }

  const found = /^@(?:cluesurf|term)\/(seed|feed)\/(.*)$/.exec(path)

  if (!found) {
    return undefined
  }

  for (const file of [join(PACKS[found[1]!]!, `${found[2]}.tree`), join(PACKS[found[1]!]!, found[2]!, 'base.tree')]) {
    if (existsSync(file)) {
      return { file, text: readFileSync(file, 'utf8') }
    }
  }

  return undefined
}

function frontEnd(text: string, roots: string[]): Program {
  const sources = collectModules({ file: 'main.tree', text }, withNativeEnv('node', resolver)).sources
  const program: Program = []

  for (const unit of sources) {
    const parsed = parse(unit)

    if (!parsed.ok) {
      throw new Error(`parse failed: ${unit.file}: ${parsed.diagnostics.map(d => d.message).join(', ')}`)
    }

    const built = mill(expandTemplates(parsed.tree), unit.file)

    if (!built.ok) {
      throw new Error(`mill failed: ${unit.file}: ${built.diagnostics.map(d => d.message).join(', ')}`)
    }

    program.push(...built.program)
  }

  extendForms(program, 'main.tree')
  disambiguateOverloads(program)
  resolveNames(program, 'main.tree')

  const errors = check(program, 'main.tree').filter(d => d.severity !== 'warning')

  if (errors.length) {
    throw new Error(`check failed: ${errors.slice(0, 8).map(d => d.message).join(' | ')}`)
  }

  resolveAsync(program)

  return simplify(program, new Set(roots))
}

const readRuntime = (p: string): string | undefined => (existsSync(p) ? readFileSync(p, 'utf8') : undefined)

interface Suite {
  label: string
  mineFile: string
  substrate: Substrate
  cursorImportPath: string
  extraImports: string[]
  entryTaskName: string
  entryTaskBody: string
  cases: [string, string, string][]
  expectRules: number
}

function runSuite(suite: Suite): void {
  const mineText = readFileSync(suite.mineFile, 'utf8')
  const mineParsed = parse({ file: suite.mineFile, text: mineText })

  if (!mineParsed.ok) {
    ok(`${suite.label}: parses`, false, mineParsed.diagnostics.map(d => d.message).join(', '))

    return
  }

  const grammar = readFeedMineGrammar(mineParsed.tree)

  ok(`${suite.label}: grammar reads ${suite.expectRules} named rules`, grammar.size === suite.expectRules, `got ${[...grammar.keys()].join(', ')}`)

  const generated = compileFeedMine(grammar, suite.substrate, suite.cursorImportPath, suite.extraImports)
  const entry = `${generated}\n${suite.entryTaskBody}\n`

  console.log(`--- ${suite.label} generated .tree source ---`)
  console.log(generated)
  console.log('--- end ---')

  try {
    const program = frontEnd(entry, [suite.entryTaskName])
    const ts = `${nativePrelude(program, 'node', readRuntime)}\n${emitTypeScript(program)}`

    ok(`${suite.label}: compiles through the ordinary pipeline`, true)

    const dir = mkdtempSync(join(tmpdir(), 'feed-mill-run-'))
    const file = join(dir, 'generated.ts')
    const jsName = suite.entryTaskName.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
    const inputs = suite.cases.map(([, input]) => JSON.stringify(input))
    const main = `\nfor (const input of [${inputs.join(', ')}]) { console.log(${jsName}(input)) }\n`

    writeFileSync(file, `${ts}${main}`)

    const output = execFileSync('npx', ['tsx', file], { encoding: 'utf8' }).trim().split('\n')

    suite.cases.forEach(([name, , want], i) => {
      const got = output[i]

      ok(`${suite.label}: ${name}`, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
    })
  } catch (error) {
    ok(`${suite.label}: compiles through the ordinary pipeline`, false, String((error as Error).stack ?? error))
  }
}

// hex: text substrate, list/form/any/range/value/send.
runSuite({
  label: 'hex',
  mineFile: join(TERM, 'deck/feed/code/hex/mine.tree'),
  substrate: 'text',
  cursorImportPath: '@term/feed/code/base',
  extraImports: ['load @term/feed/code/hex/code', '  find hex-digit-value', ''],
  entryTaskName: 'round-generated-hex',
  entryTaskBody: [
    'task round-generated-hex',
    '  take input, like text',
    '  like text',
    '  save cursor',
    '    call make-text-cursor(read input)',
    '  save bytes',
    '    call read-hex(read cursor)',
    '  send back',
    '    call write-hex(read bytes)',
  ].join('\n'),
  cases: [
    ['lowercase round trips', '00ff7a', '00ff7a'],
    ['uppercase input still lower-cases', '00FF7A', '00ff7a'],
    ['the empty string round trips to itself', '', ''],
    ['a longer real-looking value', 'deadbeefcafef00d', 'deadbeefcafef00d'],
  ],
  expectRules: 3,
})

// gzip: byte substrate, byte/int/bytes/maybe/until/let, plus a nested rule (extra-field) and a real bug this
// grammar's own missing `mine value` construction found (see gzip/mine.tree's header comment). `read-gzip` is
// the GENERATED reader here (the whole point), so gzip/code.tree's own `read-gzip` is deliberately not
// imported — only `write-gzip`, a different name, to round-trip and compare against the same hex-bridged
// fixture `deck/feed/test/gzip.tree` and `test/compile/feed-native.ts`'s own GZIP suite already prove.
runSuite({
  label: 'gzip',
  mineFile: join(TERM, 'deck/feed/code/gzip/mine.tree'),
  substrate: 'byte',
  cursorImportPath: '@term/feed/code/base',
  extraImports: [
    'load @term/feed/code/gzip/form',
    '  find gzip-file',
    '',
    'load @term/feed/code/gzip/code',
    '  find write-gzip',
    '',
    'load @term/feed/code/hex/code',
    '  find read-hex',
    '  find write-hex',
    '',
  ],
  entryTaskName: 'round-generated-gzip',
  entryTaskBody: [
    'task round-generated-gzip',
    '  take input, like text',
    '  like text',
    '  save cursor',
    '    call make-cursor(call read-hex(read input))',
    '  save file',
    '    call read-gzip(read cursor)',
    '  send back',
    '    call write-hex(call write-gzip(read file))',
  ].join('\n'),
  cases: [
    [
      'a minimal header+trailer round trips byte for byte',
      '1f8b08000000000000ffaabb7856341202000000',
      '1f8b08000000000000ffaabb7856341202000000',
    ],
  ],
  expectRules: 3,
})

console.log(`\nfeed-mill-run: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
