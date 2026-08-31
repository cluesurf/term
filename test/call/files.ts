// Which `.tree` files a command actually operates on.
//
// `collectTreeFiles` is what `term form`, `term lint`, `term time` and `term hold` walk with, and it did not
// honour either of the two ways this codebase shelves a file. So `term form deck --check` reported 33 files it
// COULD NOT PARSE, and 32 of them were deliberately shelved drafts — several not written in Term at all
// (`deck/feed/code/ansi/mine.tree` is a regex, `deck/seed/code/native/browser/motion.tree` is JavaScript). A
// check that cannot reach zero is a check nobody can put in a gate, which is what lint-and-format needs of it.
//
// It also walked into `link/`, where `term link` puts a DEPENDENCY's source, so three of those 33 were
// @term/seed's own files reported a second time through @term/zone's link directory. Formatting another
// package's source is never what a command run in this project was asked to do.
//
// A FILE NAMED EXPLICITLY IS STILL TAKEN, draft or not. Walking a directory means "everything here that counts";
// naming a file is a direct request, and refusing to format a draft somebody pointed at would be answering a
// question they did not ask.
//
// Run: npx tsx test/call/files.ts

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectTreeFiles } from '@term/call/code/files'

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

const root = mkdtempSync(join(tmpdir(), 'term-files-'))

const put = (name: string, text = 'task probe\n  like number\n  send back, code 1\n'): void => {
  const full = join(root, name)

  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text)
}

put('code/plain.tree')
put('code/shelved.tree', 'note draft\n\nthis is not Term at all\n')
put('code/deep/draft.tree', '')
put('code/deep/inside.tree')
put('code/deep/further/down.tree')
put('link/@term/other/borrowed.tree')
put('host/emitted.tree')
put('node_modules/dep/thing.tree')

const walked = (await collectTreeFiles([], root)).map(f => f.slice(root.length + 1))

ok('an ordinary file is collected', walked.includes('code/plain.tree'), walked.join(' '))

ok(
  'a file declaring `note draft` is not',
  !walked.includes('code/shelved.tree'),
  walked.join(' '),
)

ok(
  'a directory holding `draft.tree` takes itself and everything under it out',
  !walked.some(f => f.startsWith('code/deep/')),
  walked.join(' '),
)

ok(
  "`link/` is another package's source and is left alone",
  !walked.some(f => f.startsWith('link/')),
  walked.join(' '),
)

ok(
  'host/ and node_modules/ are left alone, as before',
  !walked.some(f => f.startsWith('host/') || f.startsWith('node_modules/')),
  walked.join(' '),
)

ok('so exactly one file is collected here', walked.length === 1, walked.join(' '))

// ---- naming a file is a direct request ----

const named = await collectTreeFiles(['code/shelved.tree'], root)

ok(
  'a shelved file named explicitly is still collected',
  named.length === 1 && named[0]!.endsWith('code/shelved.tree'),
  named.join(' '),
)

const namedInside = await collectTreeFiles(['code/deep/inside.tree'], root)

ok(
  'and so is a file inside a shelved directory',
  namedInside.length === 1,
  namedInside.join(' '),
)

console.log(`\nfiles: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
