// Does `term make` compile a DIALECT, rather than only the test harness?
//
// Everything feed-mill could do lived in test/compile/feed-mill-run.ts, which builds its own front end and hands
// the compiler a substrate by hand. A dialect could not be built by anybody but that harness, which means it could
// not be SHIPPED: a grammar in the tree emitted nothing, and the reader people actually imported was the
// hand-written `code.tree` beside it. Two spellings of one grammar, and the ordinary outcome of two spellings.
//
// A `mine.tree` IS THE SOURCE NOW. `compileProject` recognises one, generates the reader it describes, and compiles
// that into `host/` at the grammar's own path, so a dialect is written once. This holds the three claims that makes:
//
//   THE GRAMMAR IS RECOGNISED BY CONTENT, not by its name. `mine.tree` is a strong hint and nothing more: the tree
//   already has a 0-byte `deck/feed/code/font/otf/mine.tree`, and a file called `deck.tree` that is an ordinary
//   stdlib module. Reading a name instead of a file is the mistake that once skipped the entire stdlib from the
//   build, silently, while reporting success on the twenty files left.
//
//   THE SUBSTRATE IS INFERRED. A build has nobody to ask, and `feedMineSubstrate` does not need asking.
//
//   A GRAMMAR IT CANNOT INFER IS REPORTED, never guessed. Guessing emits a reader that compiles clean and reads the
//   wrong cursor, which is the exact failure mode this project keeps finding.
//
// Run: npx tsx test/compile/feed-mill-build.ts

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { compileProject } from '@term/call/code/make'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${info ? `  ${info}` : ''}`)
  }
}

// a project on disk, with the files it is given
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'feed-mill-build-'))

  for (const [name, text] of Object.entries(files)) {
    const full = join(root, name)

    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
  }

  return root
}

const DECK = 'deck @term/probe\n'

// ---- a real grammar builds ----
//
// hex's own shipped grammar, with its `note draft` removed. That marker says the file "can never pass term make's
// type checker", which was true of a grammar compiled as CODE and is the thing this change retires: what has to
// pass the checker is the reader generated FROM it.

const hex = readFileSync(join(TERM, 'deck/feed/code/hex/mine.tree'), 'utf8')
  .split('\n')
  .filter(line => line.trim() !== 'note draft')
  .join('\n')

// The helper hex's `mine value` calls, which the grammar imports with its own `load ./code`. The real dialect has
// this in ./code.tree beside `read-hex`; the fixture takes only the helper, because the hand-written `read-hex`
// would collide with the generated one (names are package-global). Retiring that duplicate is format-mill-0007.
const helper = `task hex-digit-value
  take code, like number
  like number
  send back
    call subtract
      read code
      code 48
`

const built = project({
  'deck.tree': DECK,
  'code/hex/mine.tree': hex,
  'code/hex/code.tree': helper,
})
const result = compileProject(built)

ok(
  'a dialect grammar compiles as part of an ordinary build',
  result.failed === 0 && result.compiled === 2,
  `${result.compiled} compiled (want 2: the grammar and its helper), ${result.failed} failed: ${result.errors.slice(0, 2).join(' | ')}`,
)

const emitted = join(built, 'host/code/hex/mine.ts')

ok('the reader is emitted at the grammar\'s own path', existsSync(emitted), emitted)

if (existsSync(emitted)) {
  const js = readFileSync(emitted, 'utf8')

  // ONE FUNCTION PER RULE THE GRAMMAR DECLARES, named for it. hex declares three (`hex`, `hex-byte`,
  // `hex-digit`), so all three must be here: a rule the generator drops leaves the reader parsing, milling and
  // quietly incomplete, which is the failure mode this whole project keeps finding.
  const wanted = ['readHex', 'readHexByte', 'readHexDigit']

  for (const name of wanted) {
    ok(`the emitted module defines ${name}`, js.includes(`function ${name}`))
  }

  // it reads a TEXT cursor, which is what the substrate inferred, and the proof it was not guessed the other way.
  // Both halves matter: a byte substrate would have emitted `feedCursorRead` over the same grammar, and asserting
  // only the presence of one would pass on a reader that emitted both.
  ok(
    'the emitted reader reads a text cursor, as inferred',
    js.includes('textCursorRead(') && !js.includes('feedCursorRead('),
    'a byte substrate would have emitted feedCursorRead',
  )

  // the helper the grammar imports with its own `load ./code` came through. Without it the reader references a
  // name nothing defines, which is exactly how this integration first failed.
  ok(
    'the helper the grammar imports is in scope',
    js.includes('hexDigitValue'),
    'the grammar\'s own load block was dropped',
  )
}

// ---- a 0-byte mine.tree is not a grammar ----
//
// deck/feed/code/font/otf/mine.tree is exactly this: a placeholder, and ordinary Term code as far as the build is
// concerned. A filename test would have sent it to the generator, which would have emitted a reader with no rules.

const empty = project({ 'deck.tree': DECK, 'code/thing/mine.tree': '' })
const emptyResult = compileProject(empty)

ok(
  'an empty mine.tree is compiled as code, not read as a grammar',
  emptyResult.failed === 0 && emptyResult.compiled === 1,
  `${emptyResult.compiled} compiled, ${emptyResult.failed} failed`,
)

// ---- a grammar with no leaf is reported, not guessed ----
//
// Sixteen of @term/feed's readable grammars are in this state today: pure combinators over rules that are still a
// name and a blank line. There is nothing in them that can only read bytes and nothing that can only read text,
// so a build has to say so rather than pick one.

const vague = project({
  'deck.tree': DECK,
  'code/vague/mine.tree': [
    'mine thing',
    '  mine form, form other',
    '',
    'mine other',
    '  mine form, form thing',
    '',
  ].join('\n'),
})
const vagueResult = compileProject(vague)

ok(
  'a grammar with no leaf to infer from fails the build',
  vagueResult.failed === 1 && vagueResult.compiled === 0,
  `${vagueResult.compiled} compiled, ${vagueResult.failed} failed`,
)

ok(
  'and says why, and what to do about it',
  vagueResult.errors.some(
    e => e.includes('bytes or text') && e.includes('note draft'),
  ),
  vagueResult.errors.join(' | ').slice(0, 200),
)

console.log(`\nfeed-mill-build: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
