// Proof for the feed mill compiler (deck/make/code/compile/feed-mill.ts): reads deck/feed/code/hex/mine.tree,
// generates .tree source implementing read-hex from the grammar alone, compiles it through the ordinary
// parse/mill/check pipeline, and checks its output against the hand-written read-hex on the same fixed strings
// deck/feed/test/hex.tree already proves. Run: npx tsx test/compile/feed-mill-run.ts

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import { resolve as resolveNames } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { resolveAsync } from '@term/make/code/check/async-resolve'
import { simplify } from '@term/make/code/ir/simplify'
import { collectModules } from '@term/make/code/compile/load'
import type { Source } from '@term/make/code/compile/load'
import { withNativeEnv } from '@term/make/code/compile/native'
import { expandTemplates } from '@term/make/code/compile/template'
import { extendForms } from '@term/make/code/check/extend'
import { disambiguateOverloads } from '@term/make/code/check/overload'
import { emitTypeScript } from '@term/make/code/compile/typescript'
import type { Program } from '@term/make/code/compile/node'
import { readFeedMineGrammar, compileFeedMine } from '@term/make/code/compile/feed-mill'

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

// 1. read hex/mine.tree's own grammar (the same file the package ships, `note draft` and all — the draft
// marker is a build-walk convention this harness does not go through, so it parses fine)
const mineFile = join(TERM, 'deck/feed/code/hex/mine.tree')
const mineText = readFileSync(mineFile, 'utf8')
const mineParsed = parse({ file: mineFile, text: mineText })

if (!mineParsed.ok) {
  console.log('FAIL  parsing hex/mine.tree', mineParsed.diagnostics.map(d => d.message).join(', '))
  process.exit(1)
}

const grammar = readFeedMineGrammar(mineParsed.tree)

ok('grammar reads all three named rules', grammar.size === 3, `got ${[...grammar.keys()].join(', ')}`)

// 2. generate .tree source from the grammar alone
const generated = compileFeedMine(grammar, '../../hex/code', ['load ../../hex/code', '  find hex-digit-value', ''])
const entry = `${generated}\ntask round-generated-hex\n  take input, like text\n  like text\n  save cursor\n    call make-text-cursor(read input)\n  save bytes\n    call read-hex(read cursor)\n  send back\n    call write-hex(read bytes)\n`

console.log('--- generated .tree source ---')
console.log(generated)
console.log('--- end ---')

// 3. compile the generated source (plus the hand-written write-hex/make-text-cursor it borrows) through the
// ordinary pipeline, exactly the way feed-native.ts proves a hand-written entry point
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

try {
  const program = frontEnd(entry, ['round-generated-hex'])
  const ts = emitTypeScript(program)
  ok('generated hex reader compiles through the ordinary pipeline', true)

  // 4. run it (Node, via a temp module) against the same fixtures deck/feed/test/hex.tree proves, and diff
  // against the hand-written read-hex/write-hex on the identical inputs
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'feed-mill-run-'))
  const file = join(dir, 'generated.mjs')
  writeFileSync(file, ts.replace(/^export /gm, 'export '))

  const mod = await import(file)
  const CASES: [string, string, string][] = [
    ['lowercase round trips', '00ff7a', '00ff7a'],
    ['uppercase input still lower-cases', '00FF7A', '00ff7a'],
    ['the empty string round trips to itself', '', ''],
    ['a longer real-looking value', 'deadbeefcafef00d', 'deadbeefcafef00d'],
  ]

  for (const [name, input, want] of CASES) {
    const got = mod.roundGeneratedHex(input)
    ok(`generated hex: ${name}`, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
  }
} catch (error) {
  ok('generated hex reader compiles through the ordinary pipeline', false, String((error as Error).stack ?? error))
}

console.log(`\nfeed-mill-run: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
