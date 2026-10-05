// Name-level cutoff (note/term/plan/incremental-best-in-class.md, step 4). A unit's stored answer is keyed by the
// fingerprints of the dependency definitions it can reach BY NAME (compile/names.tree), so an edit to a task it never
// names leaves its answer standing, an edit to one it calls does not, and a definition that appears under a name it
// uses moves its key even though nothing it used before changed.
//
// Each build is a fresh run (no unit memo) against one cache, as successive `term make` runs are.
// Run: npx tsx test/compile/name-cutoff.ts

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { compileSeparate } from '@term/make/code/compile/separate'
import { CompileCache } from '@term/make/code/compile/cache'
import { projectResolver } from '@term/call/code/make'

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

const root = mkdtempSync(join(tmpdir(), 'name-cutoff-'))
mkdirSync(join(root, 'code'), { recursive: true })
writeFileSync(join(root, 'deck.tree'), `deck @probe/names\n  mark <0.0.1>\n`)

const helper = join(root, 'code', 'helper.tree')
const entry = join(root, 'code', 'base.tree')
const entryText = `load ./helper\n  find greet\n\nload @term/base/text\n  find trim\n\ntask main\n  like text\n  back trim(greet(<you>))\n`

writeFileSync(entry, entryText)

const cache = new CompileCache()

const build = (helperText: string) => {
  writeFileSync(helper, helperText)

  const result = compileSeparate({ file: entry, text: entryText }, { resolve: projectResolver(root), cache, modules: f => `./${f}` })

  if (!result.ok) {
    return { ok: false as const, why: result.diagnostics.map(d => d.message).join(' | ') }
  }

  // by the file's own name: the resolver answers a load by its real path, `/private/var` where the test wrote `/var`
  const built = (file: string): boolean => result.built.some(label => label.split('+').some(one => one.endsWith(`/code/${basename(file)}`)))

  return { ok: true as const, helper: built(helper), entry: built(entry), all: result.built }
}

const greet = `task greet\n  take who, like text\n  like text\n  back <hello {who}>\n`
const other = (params: string): string => `task other\n${params}  like number\n  back 1\n`

const first = build(`${greet}\n${other('  take n, like number\n')}`)
ok('the first build builds', first.ok, first.ok ? '' : first.why)
ok('and builds both units', first.ok && first.helper && first.entry)

const unused = build(`${greet}\n${other('  take n, like number\n  take m, like number\n')}`)
ok('a signature edit to a task the entry never names builds', unused.ok, unused.ok ? '' : unused.why)
ok('rebuilds the edited unit', unused.ok && unused.helper)
ok('and leaves the entry\'s answer standing', unused.ok && !unused.entry, unused.ok ? unused.all.join(', ') : '')

const usedEdit = build(`task greet\n  take who, like text\n  take mark, like text, fall <!>\n  like text\n  back <hello {who}{mark}>\n\n${other('  take n, like number\n  take m, like number\n')}`)
ok('a signature edit to the task the entry calls builds', usedEdit.ok, usedEdit.ok ? '' : usedEdit.why)
ok('and rebuilds the entry', usedEdit.ok && usedEdit.entry)

// a definition that appears under a name the entry uses, though the entry loads it from elsewhere: in the flat
// namespace it joins the name's overloads, so it can change which `trim` the entry's call reaches
const shadow = build(`task greet\n  take who, like text\n  take mark, like text, fall <!>\n  like text\n  back <hello {who}{mark}>\n\n${other('  take n, like number\n  take m, like number\n')}\ntask trim\n  take a, like number\n  take b, like number\n  like number\n  back a\n`)
ok('a new definition of a name the entry uses builds', shadow.ok, shadow.ok ? '' : shadow.why)
ok('and rebuilds the entry, which looked that name up', shadow.ok && shadow.entry)

const same = build(`task greet\n  take who, like text\n  take mark, like text, fall <!>\n  like text\n  back <hello {who}{mark}>\n\n${other('  take n, like number\n  take m, like number\n')}\ntask trim\n  take a, like number\n  take b, like number\n  like number\n  back a\n`)
ok('an unchanged build builds nothing', same.ok && same.all.length === 0, same.ok ? same.all.join(', ') : same.why)

console.log(`\nname-cutoff: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
