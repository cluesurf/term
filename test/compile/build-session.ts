// A build graph kept across rebuilds (note/term/plan/incremental-best-in-class.md, steps 2 and 3). A watch keeps one
// `BuildSession`: each module's walk, each load's answer, each module's parse, each unit's answer and each entry's
// outcome. What it must never do is answer an edited file with the text it had before, which a kept resolver and a
// kept walk both could, since an answer to a load is a file AND its text. And an entry no edit reaches must be
// replayed rather than built, with the problems it had.
//
// One project, two entries: `base` loads `helper`, `other` loads neither. It is built through one session as it is,
// after an edit to `helper`, unchanged, and after a file is added.
// Run: npx tsx test/compile/build-session.ts

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSession, compileProjectSeparate, unitSlug } from '@term/call/code/make'
import { projectCache } from '@term/call/code/cache-store'

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

// by its real path, as `term make` runs from one: the temporary directory is `/var` behind a link to `/private/var`,
// and a module the walk reaches by both names is two modules
const root = realpathSync(mkdtempSync(join(tmpdir(), 'build-session-')))
mkdirSync(join(root, 'code'), { recursive: true })
writeFileSync(join(root, 'deck.tree'), `deck @probe/session\n  mark <0.0.1>\n`)

const helper = join(root, 'code', 'helper.tree')
const helperText = (word: string): string => `load @term/base/text\n  find trim\n\ntask greet\n  like text\n  back trim(< ${word} >)\n`

writeFileSync(helper, helperText('first'))
writeFileSync(join(root, 'code', 'base.tree'), `load ./helper\n  find greet\n\ntask main\n  like text\n  back greet()\n`)
// an entry the edit cannot reach, with a warning of its own: a local nothing reads
writeFileSync(join(root, 'code', 'other.tree'), `task other\n  like number\n  save unused, 2\n  back 1\n`)

const unitText = (): string => readFileSync(join(root, 'host', '.unit', `${unitSlug(root, helper)}.ts`), 'utf8')
const otherShim = join(root, 'host', 'code', 'other.ts')

const session = buildSession(root)
const cache = projectCache(root)

const one = compileProjectSeparate(root, cache, 'node', session)
ok('the first build builds', one.failed === 0, one.errors.join(' | '))
ok('and emits the helper as written', unitText().includes('first'))
ok('the unreached entry has its warning', one.warnings.some(w => w.includes('unused')), one.warnings.join(' | '))

const walkedBefore = new Map(session.walked)

// a different length, so the edit moves the file's size as well as its time. The unreached entry's artifact is
// marked, so a rebuild of it would show: a build writes it back, a replay leaves it
writeFileSync(helper, helperText('second edition'))
writeFileSync(otherShim, '// not rebuilt\n')

const two = compileProjectSeparate(root, cache, 'node', session)
ok('the rebuild after an edit builds', two.failed === 0, two.errors.join(' | '))
ok('and emits the helper as it is now, not as the session first read it', unitText().includes('second edition'), unitText())
ok('the edited module was walked again', session.walked.get(helper) !== walkedBefore.get(helper))

const kept = [...walkedBefore].filter(([file, walk]) => file.includes('/deck/base/') && session.walked.get(file) === walk)
const stdlib = [...walkedBefore.keys()].filter(file => file.includes('/deck/base/'))
ok('every standard library module kept its walk', stdlib.length > 0 && kept.length === stdlib.length, `${kept.length} of ${stdlib.length}`)
ok('only the edited unit and the units above it were built', two.built > 0 && two.built <= 2, `${two.built} built`)
ok('the entry the edit cannot reach was replayed, not built', readFileSync(otherShim, 'utf8') === '// not rebuilt\n')
ok('with its warning', two.warnings.length === one.warnings.length, `${two.warnings.length} of ${one.warnings.length}`)
ok('and every entry counted', two.compiled === one.compiled, `${two.compiled} of ${one.compiled}`)

const three = compileProjectSeparate(root, cache, 'node', session)
ok('an unchanged rebuild builds nothing', three.failed === 0 && three.built === 0, `${three.built} built`)
ok('and wrote nothing', three.written === 0, `${three.written} written`)
ok('and reports what it reported before', three.warnings.join('\n') === two.warnings.join('\n'))

// a new file may be what a load that found nothing now finds, so the session starts over and every entry builds
writeFileSync(join(root, 'code', 'added.tree'), `task added\n  like number\n  back 3\n`)

const four = compileProjectSeparate(root, cache, 'node', session)
ok('a build after a file is added builds', four.failed === 0, four.errors.join(' | '))
ok('and builds every entry again', readFileSync(otherShim, 'utf8') !== '// not rebuilt\n')
ok('the added file among them', four.compiled === one.compiled + 1, `${four.compiled}`)

console.log(`\nbuild-session: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
