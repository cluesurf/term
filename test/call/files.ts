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
import { dirname, join } from 'node:path'
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

// ---- a role file is not code ----
//
// A role file says which mill reads which file, and for `hook` whether a file holds CLI commands or URL routes.
// It is configuration, read through the role mill, and `role` is not a code statement — so the build compiling
// one reports `the name "role" is not defined` on a file nobody wrote as code. deck/seed/role/base.tree carries
// `note draft` for exactly that reason, which shelves a LIVE file to silence an error that should not exist.
//
// BY CONTENT, like the manifest and the lockfile before it. That matters here more than usual: this package's own
// role file is `role/base.tree`, so a filename test would have missed the one that counts.

{
  const { isRoleFileText } = await import('@term/call/code/manifest-name')

  ok(
    'a `role <name>` with `take` globs reads as a role file',
    isRoleFileText('role site\n  take @/code/route/**/*.tree\n', 'anything.tree'),
  )

  ok(
    'whatever it is called',
    isRoleFileText('role call\n  take @/code/line/**/*.tree\n', 'base.tree'),
  )

  // a MANIFEST writes `role ./base/role` as a field under `deck`, not a top-level statement with `take` children
  ok(
    'a manifest naming a role directory is not one',
    !isRoleFileText('deck @term/thing\n  code <0.0.1>\n  role ./role\n', 'deck.tree'),
  )

  // and ordinary code is not one
  ok(
    'ordinary code is not one',
    !isRoleFileText('task role\n  like void\n  send back\n', 'role.tree'),
  )
}

// ---- where a role file lives ----
//
// `base/role.tree` is the DEFAULT, so a package needs no `role` line in its manifest to have one. A manifest that
// declares `role <path>` still wins, and a directory there resolves the way every other Term path does:
// `<dir>.tree`, then `<dir>/base.tree`, then `<dir>/note.tree`.
//
// That last part was the whole bug. Only `<dir>/role.tree` was tried, so this package's own `role ./role`
// pointing at `role/base.tree` found NOTHING and `readRoles` returned undefined. Every file in the tree answered
// `null` for its role — `code`, `book`, `view`, `host`, all of it — and the role system was inert without
// saying so to anyone.

{
  const { projectRoleOf } = await import('@term/call/code/role-of')

  const roleRoot = mkdtempSync(join(tmpdir(), 'term-role-'))
  const write = (name: string, text: string): void => {
    mkdirSync(dirname(join(roleRoot, name)), { recursive: true })
    writeFileSync(join(roleRoot, name), text)
  }

  write('deck.tree', 'deck @term/probe\n  code <0.0.1>\n')
  write('base/role.tree', 'role site\n  take @/code/route/**/*.tree\n')
  write('code/route/one.tree', 'task t\n')
  write('code/other.tree', 'task t\n')

  const roleOf = projectRoleOf(roleRoot)

  ok(
    '`base/role.tree` is found with no `role` line in the manifest',
    roleOf(join(roleRoot, 'code/route/one.tree')) === 'site',
    String(roleOf(join(roleRoot, 'code/route/one.tree'))),
  )

  ok(
    'and a file no rule matches has no role',
    roleOf(join(roleRoot, 'code/other.tree')) === null,
    String(roleOf(join(roleRoot, 'code/other.tree'))),
  )

  // a manifest that names a DIRECTORY resolves `<dir>/base.tree`, which is what `role ./role` meant all along
  const declared = mkdtempSync(join(tmpdir(), 'term-role-declared-'))
  const put2 = (name: string, text: string): void => {
    mkdirSync(dirname(join(declared, name)), { recursive: true })
    writeFileSync(join(declared, name), text)
  }

  put2('deck.tree', 'deck @term/probe\n  code <0.0.1>\n  role ./elsewhere\n')
  put2('elsewhere/base.tree', 'role call\n  take @/code/**/*.tree\n')
  put2('code/one.tree', 'task t\n')

  ok(
    '`role ./elsewhere` resolves `elsewhere/base.tree`, not only `elsewhere/role.tree`',
    projectRoleOf(declared)(join(declared, 'code/one.tree')) === 'call',
    String(projectRoleOf(declared)(join(declared, 'code/one.tree'))),
  )
}

// ---- a role file is PER PACKAGE ----
//
// A build pulls in a dependency's source, and that source is written against its OWN package's conventions:
// @term/site says its `code/test/site/route.tree` holds routes, and no project depending on it should have to
// know or repeat that. One role file read at the build root gave a dependency's files the ROOT project's rules,
// which describe the root's layout and say nothing true about the dependency's.
//
// It is also what makes `@` mean the right thing. A glob's `@` is the package root, so `@/code/**` in a
// dependency's role file has to expand against THAT package's directory, not against whoever is building.

{
  const { projectRoleOf } = await import('@term/call/code/role-of')

  const outer = mkdtempSync(join(tmpdir(), 'term-pkg-role-'))
  const add = (name: string, text: string): void => {
    mkdirSync(dirname(join(outer, name)), { recursive: true })
    writeFileSync(join(outer, name), text)
  }

  // the outer project: everything under code/ is `code`
  add('deck.tree', 'deck @term/outer\n  code <0.0.1>\n')
  add('base/role.tree', 'role code\n  take @/code/**/*.tree\n')
  add('code/mine.tree', 'task t\n')

  // a nested package with its OWN role file, saying something the outer one does not
  add('deck/inner/deck.tree', 'deck @term/inner\n  code <0.0.1>\n')
  add('deck/inner/base/role.tree', 'role site\n  take @/code/route/**/*.tree\n')
  add('deck/inner/code/route/page.tree', 'task t\n')
  add('deck/inner/code/other.tree', 'task t\n')

  const roleOf = projectRoleOf(outer)

  ok(
    "a nested package's file gets ITS OWN role, not the root project's",
    roleOf(join(outer, 'deck/inner/code/route/page.tree')) === 'site',
    String(roleOf(join(outer, 'deck/inner/code/route/page.tree'))),
  )

  ok(
    "and a file its own role file does not match has none, rather than falling back to the root's",
    roleOf(join(outer, 'deck/inner/code/other.tree')) === null,
    String(roleOf(join(outer, 'deck/inner/code/other.tree'))),
  )

  ok(
    "the root project's own files still get the root's roles",
    roleOf(join(outer, 'code/mine.tree')) === 'code',
    String(roleOf(join(outer, 'code/mine.tree'))),
  )
}

console.log(`\nfiles: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
