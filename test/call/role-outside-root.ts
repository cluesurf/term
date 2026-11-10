// A file of a package outside the build root takes its OWN package's role file, whatever the root's path. The role
// reader (call/code/work/build/role-reading.tree package-root-of, and its original call/code/role-of.ts) climbed from
// a file toward its `deck.tree` and stopped as soon as the folder's path was no longer than the root's, a test meant
// for a file under the root. From a deep folder holding no project, the root's path is long, so a file elsewhere
// stopped at once and was given the root's (absent) role file: a `mark lean` file lost its lean surface, and its
// `make <form>` with named fields was refused. `term boot` of zone's console from such a folder failed on the CLI's
// own call/code/work/item/standard.tree that way (term-self-host-001-1113).
// Run: npx tsx test/call/role-outside-root.ts

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import { tempDir } from '../temp'
import { LINE } from './cli'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info.slice(0, 1200)}`)
  }
}

// a package whose role file reads code/ as lean, and one lean file that builds a form by its field names
const pkg = tempDir('term-own-')
mkdirSync(join(pkg, 'code'), { recursive: true })
writeFileSync(
  join(pkg, 'deck.tree'),
  'deck @probe/own\nhead <Probe>\nmark <0.0.2>\nlink @term/base, mark <0.0.x>\n',
)
writeFileSync(join(pkg, 'role.tree'), 'role code\n  mark lean\n  take @/code/**/*.tree\n')
const file = join(pkg, 'code', 'item.tree')
writeFileSync(
  file,
  [
    'form thing',
    '  link name, like text',
    '  link size, like number',
    '',
    'task make-thing',
    '  like thing',
    '',
    '  back',
    '    make thing',
    '      name <x>',
    '      size 2',
    '',
  ].join('\n'),
)

// the build root: a folder holding no project, not an ancestor of the package, its path longer than the package's
// code folder
const far = tempDir('term-far-')
const deep = join(
  far,
  'a-folder-whose-path-is-longer-than-the-package-code-folder-it-builds-from',
)
mkdirSync(deep, { recursive: true })

ok(
  'the root is longer than the file folder, so the old length test would stop',
  deep.length > join(pkg, 'code').length,
  `${deep.length} ${join(pkg, 'code').length}`,
)

// 1. the original reader, call/code/role-of.ts
ok(
  'role-of: a file outside the root takes its own package role',
  projectRoleOf(deep)(file) === 'code',
  String(projectRoleOf(deep)(file)),
)
ok(
  'role-of: a file outside the root keeps its package lean mark',
  projectLeanOf(deep)(file) === true,
)

// 2. the CLI, whose reader is the role-reading.tree port: a build of the lean file from the deep folder
const out = tempDir('term-far-out-')
// a term started under a term run inherits TERM_DEPTH, so the child's is cleared
const env = { ...process.env }
delete env.TERM_DEPTH
const made = spawnSync(
  process.execPath,
  [LINE, 'make', file, '--emit', 'node', '--out', join(out, 'item.ts'), '--color', 'never', '--no-motion'],
  { cwd: deep, encoding: 'utf8', env },
)
const said = `${made.stdout}\n${made.stderr}`
ok('the CLI builds a lean file of an outside package from a deep folder', made.status === 0, `${made.status} ${said}`)
ok('the CLI reads the outside file as lean', !/has no slots|leaves out/.test(said), said)

console.log(`\n${pass} pass, ${fail} fail`)
if (fail > 0) {
  process.exit(1)
}
