// Proof for the feed mill compiler (deck/make/code/compile/feed-mill.ts): reads a real, shipped mine.tree
// grammar, generates .tree source implementing its reader from the grammar ALONE, compiles it through the
// ordinary parse/mill/check pipeline, and checks its output against the same fixed fixtures the hand-written
// reader already passes in deck/mill/test/feed/*.tree. Run: npx tsx test/compile/feed-mill-run.ts

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import { resolvePackagePath, sourceOf } from '@term/make/code/resolve'
import { mill } from '@term/make/code/compile/mill'
import { resolve as resolveNames } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { resolveAsync } from '@term/make/code/check/async-resolve'
import { simplify } from '@term/make/code/ir/simplify'
import { collectModules } from '@term/make/code/compile/load'
import type { Source } from '@term/make/code/compile/load'
import {
  withNativeEnv,
  nativePrelude,
} from '@term/make/code/compile/native'
import {
  collectTemplates,
  expandTemplates,
} from '@term/make/code/compile/template'
import {
  bindModules,
  stampModule,
} from '@term/make/code/check/bind-modules'
import { emitTypeScript } from '@term/make/code/compile/typescript'
import type { Program } from '@term/make/code/compile/node'
import {
  readFeedMineGrammar,
  compileFeedMine,
} from '@term/make/code/compile/feed-mill'
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

const HERE =
  import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const PACKS: Record<string, string> = {
  base: join(TERM, 'deck/base'),
  mill: join(TERM, 'deck/mill'),
}

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

  const found = /^@term\/(base|mill)\/(.*)$/.exec(path)

  if (!found) {
    return undefined
  }

  // inside the package by the package path rule every resolver calls (code root, then package root)
  return sourceOf(
    resolvePackagePath({ dir: PACKS[found[1]!]!, rest: found[2]! }),
  )
}

function frontEnd(text: string, roots: string[]): Program {
  const { sources, scope } = collectModules(
    { file: 'main.tree', text },
    withNativeEnv('node', resolver),
  )
  const program: Program = []
  const trees = sources.map(unit => {
    const parsed = parse(unit)

    if (!parsed.ok) {
      throw new Error(
        `parse failed: ${unit.file}: ${parsed.diagnostics.map(d => d.message).join(', ')}`,
      )
    }

    return { unit, tree: parsed.tree }
  })
  // every template the graph defines, as the ordinary build hands each unit (compile/unit-mill.tree
  // `graph-templates`): a `fuse` expands in another module than its `tree`, so `fuse integer, u8, ...` in
  // integer/unsigned.tree makes `to-u8` only with integer/n.tree's template in hand (term-self-host-001-0515: each
  // unit expanded alone, `to-u8` was never made, and the generated program called a `toU8` it did not define)
  const templates = new Map(
    trees.flatMap(({ tree }) => [...collectTemplates(tree)]),
  )

  for (const { unit, tree } of trees) {
    const built = mill(expandTemplates(tree, templates), unit.file)

    if (!built.ok) {
      throw new Error(
        `mill failed: ${unit.file}: ${built.diagnostics.map(d => d.message).join(', ')}`,
      )
    }

    stampModule(built.program, unit.file)
    program.push(...built.program)
  }

  // module scope and form extension, as `compileProgram` runs them (check/bind-modules.ts)
  bindModules(program, scope, 'main.tree')
  // resolve's answer is kept, so an UNDEFINED NAME fails here: the json reader's `read-pair` once read an `item`
  // nothing defined, its whitespace lists read to nothing (term-self-host-001-0516), and the gzip reader once called
  // a `to-u8` no unit had made
  const unresolved = resolveNames(program, 'main.tree').filter(
    d => d.severity !== 'warning',
  )

  if (unresolved.length) {
    throw new Error(
      `resolve failed: ${unresolved
        .slice(0, 8)
        .map(d => d.message)
        .join(' | ')}`,
    )
  }

  const errors = check(program, 'main.tree').filter(
    d => d.severity !== 'warning',
  )

  if (errors.length) {
    throw new Error(
      `check failed: ${errors
        .slice(0, 8)
        .map(d => d.message)
        .join(' | ')}`,
    )
  }

  resolveAsync(program)

  return simplify(program, new Set(roots))
}

const readRuntime = (p: string): string | undefined =>
  existsSync(p) ? readFileSync(p, 'utf8') : undefined

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
    ok(
      `${suite.label}: parses`,
      false,
      mineParsed.diagnostics.map(d => d.message).join(', '),
    )

    return
  }

  const grammar = readFeedMineGrammar(mineParsed.tree)

  ok(
    `${suite.label}: grammar reads ${suite.expectRules} named rules`,
    grammar.size === suite.expectRules,
    `got ${[...grammar.keys()].join(', ')}`,
  )

  const generated = compileFeedMine(
    grammar,
    suite.substrate,
    suite.cursorImportPath,
    suite.extraImports,
  )
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
    const jsName = suite.entryTaskName.replace(
      /-([a-z0-9])/g,
      (_, c: string) => c.toUpperCase(),
    )
    const inputs = suite.cases.map(([, input]) => JSON.stringify(input))
    // one line per case: a text as it is, any other value as JSON, a raise as RAISE and its first line (item 1352:
    // one raising case no longer hides the others' answers)
    const main = `\nfor (const input of [${inputs.join(', ')}]) { try { const got = ${jsName}(input); console.log(typeof got === 'string' ? got : JSON.stringify(got)) } catch (e) { console.log('RAISE ' + String(e?.message ?? e).split('\\n')[0]) } }\n`

    writeFileSync(file, `${ts}${main}`)

    const output = execFileSync('npx', ['tsx', file], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')

    suite.cases.forEach(([name, , want], i) => {
      const got = output[i]

      ok(
        `${suite.label}: ${name}`,
        want === 'ANY'
          ? got !== undefined && got !== '' && !got.startsWith('RAISE')
          : got === want,
        `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`,
      )
    })
  } catch (error) {
    ok(
      `${suite.label}: compiles through the ordinary pipeline`,
      false,
      String((error as Error).stack ?? error),
    )
  }
}

// hex: text substrate, list/form/any/range/value/send.
runSuite({
  label: 'hex',
  mineFile: join(TERM, 'deck/mill/code/text/hex/mine.tree'),
  substrate: 'text',
  cursorImportPath: '@term/mill/feed',
  extraImports: [
    'load @term/mill/text/hex/code',
    '  find hex-digit-value',
    '',
  ],
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
    [
      'a longer real-looking value',
      'deadbeefcafef00d',
      'deadbeefcafef00d',
    ],
  ],
  expectRules: 3,
})

// gzip: byte substrate, byte/int/bytes/maybe/until/let, plus a nested rule (extra-field) and a real bug this
// grammar's own missing `mine value` construction found (see gzip/mine.tree's header comment). `read-gzip` is
// the GENERATED reader here (the whole point), so gzip/code.tree's own `read-gzip` is deliberately not
// imported — only `write-gzip`, a different name, to round-trip and compare against the same hex-bridged
// fixture `deck/mill/test/feed/gzip.tree` and `test/compile/feed-native.ts`'s own GZIP suite already prove.
runSuite({
  label: 'gzip',
  mineFile: join(TERM, 'deck/mill/code/blob/gzip/mine.tree'),
  substrate: 'byte',
  cursorImportPath: '@term/mill/feed',
  extraImports: [
    'load @term/mill/blob/gzip/form',
    '  find gzip-file',
    '',
    'load @term/mill/blob/gzip/code',
    '  find write-gzip',
    '',
    'load @term/mill/text/hex/code',
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
    // FNAME (flag 0x08) and FCOMMENT (0x10) set: the grammar's `mine until` hands back the bytes, and its `mine
    // value` decodes them as latin-1 into the form's text fields, so 0xe9 is `é` and writes back as the one byte
    // 0xe9 (term-self-host-001-0515: the bytes went into the text field undecoded and the build refused it)
    [
      'a latin-1 name and comment round trip byte for byte',
      '1f8b08180000000000ff61e9006300aabb7856341202000000',
      '1f8b08180000000000ff61e9006300aabb7856341202000000',
    ],
  ],
  expectRules: 3,
})

// json: text substrate, and the vocabulary the other two do not reach — char/text literals, `not`, `mark`, a
// nested `mine list`, a SPAN CAPTURE (`number`), and an `any` over FORM alternatives dispatched on the first
// character. `read-true` / `read-string` / `read-number` are the GENERATED readers; json/code.tree's own reader is
// deliberately not imported.
//
// The cases read a value and hand back its text, which is what a reader can be checked on without a writer: a
// literal comes back as itself, a string keeps its quotes' contents, and a number keeps every part it was written
// with, which is the span capture doing its job.
runSuite({
  label: 'json',
  mineFile: join(TERM, 'deck/mill/code/text/json/mine.tree'),
  substrate: 'text',
  cursorImportPath: '@term/mill/feed',
  extraImports: [],
  entryTaskName: 'round-generated-json',
  entryTaskBody: [
    'task round-generated-json',
    '  take input, like text',
    '  like text',
    '  save cursor',
    '    call make-text-cursor(read input)',
    '  send back',
    '    call read-number(read cursor)',
  ].join('\n'),
  cases: [
    ['an integer reads as written', '42', '42'],
    ['a negative keeps its sign', '-7', '-7'],
    ['a decimal keeps its fraction', '3.5', '3.5'],
    ['an exponent survives', '1e10', '1e10'],
  ],
  expectRules: 15,
})

// json-value (item 1352): the readers a count-less `mine list` sits in. Each list stops where the next character is
// outside its children's whole FIRST set (the decision for term-self-host-001-1325, option a), so whitespace before a
// `,` or a `}`, the characters of a string before its closing quote, and the pairs and items of an object and an array
// end where they should. Before it every list repeated until the end of input and raised at the first character its
// form could not read
runSuite({
  label: 'json-value',
  mineFile: join(TERM, 'deck/mill/code/text/json/mine.tree'),
  substrate: 'text',
  cursorImportPath: '@term/mill/feed',
  extraImports: [],
  entryTaskName: 'round-generated-json-value',
  entryTaskBody: [
    'task round-generated-json-value',
    '  take input, like text',
    '  like unknown',
    '  save cursor',
    '    call make-text-cursor(read input)',
    '  send back',
    '    call read-value(read cursor)',
  ].join('\n'),
  cases: [
    ['an empty object', '{}', 'ANY'],
    ['an object with spaces', '{ "a" : 1 , "b": 2 }', 'ANY'],
    ['an empty array', '[]', 'ANY'],
    ['an array with spaces', '[ 1, 2 ,3 ]', 'ANY'],
    ['a plain string', '"hi"', 'ANY'],
    ['nested', '{"a": [true, null, {"b": "c"}]}', 'ANY'],
  ],
  expectRules: 15,
})

console.log(`\nfeed-mill-run: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
