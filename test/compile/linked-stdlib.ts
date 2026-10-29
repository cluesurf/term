// A STDLIB REACHED THROUGH A SYMLINKED FOLDER IS ONE MODULE PER FILE (term-compiler-0067). With
// `TERM_STDLIB=<link>/base`, where `<link>` links the real deck folder, the stdlib and sibling resolvers answered a
// package path by its LEXICAL path under the link, while the project resolver answered a relative load by its REAL
// path. So `@term/host/scan` was `<link>/host/code/scan.tree` and its `./node` was `<real>/host/code/node.tree`: one
// deck under two roots. The separate build writes each deck's root as a token in a unit's answer and reads it back as
// ONE root per deck (compile/separate.ts `portableBy`), so node.tree came back under the other spelling, scan.tree's
// `find parse-integer` reached no file that defined it, and a name two files define lost its binding:
// `The name parse-integer is not defined`, found by verb-pair, which stages a linked deck/. Only with a deck table
// (`deckOf`, as `term boot` passes) and a link path longer than the real one. Every resolver now canonicalizes through
// `realpath` (make/code/resolve.ts), as `link/` already did.
// Run: npx tsx test/compile/linked-stdlib.ts

import {
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { compileSeparate } from '@term/make/code/compile/separate'
import { CompileCache } from '@term/make/code/compile/cache'
import { projectResolver } from '@term/call/code/make'
import { projectDeckOf } from '@term/call/code/deck-of'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import { tempDir } from '../temp'

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

const top = tempDir('term-linked-stdlib-')
const real = join(top, 'real')
const code = join(real, 'base', 'code')
mkdirSync(code, { recursive: true })
writeFileSync(join(real, 'base', 'deck.tree'), 'deck @term/base\n')
// a package beside the stdlib, which the sibling resolver finds by name
const host = join(real, 'host', 'code')
mkdirSync(host, { recursive: true })
writeFileSync(join(real, 'host', 'deck.tree'), 'deck @term/host\n')

// two files define `parse-integer`, and scan.tree means node.tree's
writeFileSync(
  join(code, 'num.tree'),
  `load ./digit
  find digit-count

task parse-integer
  take text, like text
  like number
  send back, 1

task count-digits
  take text, like text
  like number
  send back, digit-count(text)

task twice
  take n, like number
  like number
  send back, add(n, n)
`,
)
writeFileSync(
  join(host, 'node.tree'),
  `task parse-integer
  take text, like text
  like number
  send back, 2
`,
)
writeFileSync(
  join(host, 'scan.tree'),
  `load ./node
  find parse-integer

load @term/base/num
  find twice

task scan-number
  take text, like text
  like number
  send back, twice(parse-integer(text))
`,
)

// a stdlib file reached only by a relative load inside the stdlib, so the stdlib's deck is met under both spellings too
writeFileSync(
  join(code, 'digit.tree'),
  `task parse-integer
  take text, like text
  like number
  send back, 3

task digit-count
  take text, like text
  like number
  send back, parse-integer(text)
`,
)

// and a file that reaches scan.tree by a relative load, so the build meets it under both spellings
writeFileSync(
  join(host, 'read.tree'),
  `load ./scan
  find scan-number

task read-number
  take text, like text
  like number
  send back, scan-number(text)
`,
)

// the deck folder reached through a link, as verb-pair stages it
// a longer path than the real one, as verb-pair's is: the deck token written for a unit is read back as ONE root per deck
const link = join(top, 'staged', 'linked-deck')
mkdirSync(join(top, 'staged'))
symlinkSync(real, link, 'dir')

// a project of its own, which loads the stdlib by package path
const project = join(top, 'project')
mkdirSync(join(project, 'code'), { recursive: true })
writeFileSync(join(project, 'deck.tree'), 'deck @test/linked\n')
const entryFile = join(project, 'code', 'main.tree')
const entry = `load @term/host/scan
  find scan-number

load @term/host/read
  find read-number

task run
  like number
  send back, add(scan-number(<7>), read-number(<8>))
`
writeFileSync(entryFile, entry)

const pinned = process.env.TERM_STDLIB

type Built = {
  ok: boolean
  diagnostics?: { name: string; message: string }[]
}

function build(stdlib: string, how: 'merged' | 'separate'): Built {
  process.env.TERM_STDLIB = stdlib

  try {
    const source = { file: entryFile, text: entry }
    const resolve = projectResolver(project)

    return how === 'merged'
      ? compile(source, { resolve, cache: new CompileCache() })
      : compileSeparate(source, {
          resolve,
          cache: new CompileCache(),
          modules: file => file,
          env: 'node',
          // the readers `term boot` builds with, each keyed by the file's path
          deckOf: projectDeckOf(),
          roleOf: projectRoleOf(project),
          leanOf: projectLeanOf(project),
        })
  } finally {
    if (pinned === undefined) {
      delete process.env.TERM_STDLIB
    } else {
      process.env.TERM_STDLIB = pinned
    }
  }
}

const said = (r: Built): string =>
  r.ok
    ? 'ok'
    : (r.diagnostics ?? [])
        .map(d => `${d.name}: ${d.message}`)
        .join(' | ')

for (const how of ['merged', 'separate'] as const) {
  const plain = build(join(real, 'base'), how)
  ok(
    `${how}: the stdlib by its real path builds`,
    plain.ok,
    said(plain),
  )

  const linked = build(join(link, 'base'), how)
  ok(
    `${how}: the stdlib through a linked folder builds`,
    linked.ok,
    said(linked),
  )
}

{
  // each answer names the file by its real path, whichever spelling reached it
  process.env.TERM_STDLIB = join(link, 'base')
  const resolve = projectResolver(project)
  const stdlib = resolve('@term/base/num', entryFile)
  const sibling = resolve('@term/host/scan', entryFile)

  if (pinned === undefined) {
    delete process.env.TERM_STDLIB
  } else {
    process.env.TERM_STDLIB = pinned
  }

  ok(
    'the stdlib resolver answers the real path',
    stdlib?.file === realpathSync(join(code, 'num.tree')),
    String(stdlib?.file),
  )
  ok(
    'the sibling resolver answers the real path',
    sibling?.file === realpathSync(join(host, 'scan.tree')),
    String(sibling?.file),
  )
}

console.log(`\n${pass} passed, ${fail} failed`)

if (fail > 0) {
  process.exit(1)
}
