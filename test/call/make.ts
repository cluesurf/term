// `seed make` project build: incremental artifact writes (only files whose output changed are rewritten) and rich,
// colored compiler diagnostics. Run: npx tsx test/call/make.ts

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileProject } from '@term/call/code/make'
import { compile } from '@term/make/code/compile/compile'
import { renderDiagnostic } from '@term/call/code/report'

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

const GOOD = `task double
  take n, like number
  like number
  send back
    call add
      read n
      read n
`

const root = mkdtempSync(join(tmpdir(), 'seed-make-'))
mkdirSync(join(root, 'src'), { recursive: true })
writeFileSync(join(root, 'src', 'math.tree'), GOOD)

// 1. the first build compiles the file and WRITES its artifact under host/.
const first = compileProject(root)
ok('first build compiles the file', first.compiled === 1 && first.failed === 0)
ok('first build writes the artifact', first.written === 1)
ok(
  'artifact lands under host/ mirroring the source tree',
  existsSync(join(root, 'host', 'src', 'math.ts')),
)

// 2. a rebuild with NO change writes nothing (content-addressed: the output matches what is already on disk).
const second = compileProject(root)
ok('rebuild still reports the file compiled', second.compiled === 1)
ok('rebuild writes NOTHING when the output is unchanged', second.written === 0)

// 3. editing the source so its output differs rewrites just that file.
writeFileSync(
  join(root, 'src', 'math.tree'),
  GOOD.replace('read n\n      read n', 'read n\n      call multiply\n        read n\n        read n'),
)
const third = compileProject(root)
ok('an edited file is rewritten', third.written === 1 && third.failed === 0)

// 4. a compile error is reported as a RICH, colored frame (header with the code, a source caret), not a flat one-liner.
writeFileSync(
  join(root, 'src', 'bad.tree'),
  `task bad
  take n, like number
  like text
  send back
    read n
`,
)
const fourth = compileProject(root)
ok('a broken file is counted as failed', fourth.failed >= 1)
ok(
  'the diagnostic is a kink-style frame (header + caret), not a one-liner',
  fourth.errors.some(e => e.includes('kink') && e.includes('site') && e.includes('^')),
  fourth.errors.join('\n'),
)

// 5. renderDiagnostic shows the offending source line and a locator.
const broken = compile({
  file: 'b.tree',
  text: 'task bad\n  take n, like number\n  like text\n  send back\n    read n\n',
})
ok(
  'renderDiagnostic includes the file:line:col locator and the source frame',
  broken.ok === false &&
    (() => {
      const frame = renderDiagnostic(broken.diagnostics[0]!, 'task bad\n  take n, like number\n  like text\n  send back\n    read n\n')
      return frame.includes('b.tree:') && frame.includes('send back')
    })(),
)

// 6. A RELATIVE IMPORT SURVIVES A SYMLINKED PROJECT PATH.
//
// A relative import is confined to its own package, so `load ../../../../etc/passwd` cannot read the host
// filesystem during a compile of untrusted source. The confinement compares the resolved candidate against the
// package root, and it used to compare a REAL path against an unresolved one: the package root exists and so was
// resolved through its symlinks, while the candidate is a bare `.../code` with no extension yet and so was not.
//
// On any project path crossing a symlink the two are spelled differently, every relative import in the project
// resolved to nothing, and the failure surfaced far away as `the name "x" is not defined` at the CALL, never at
// the import. Every macOS temporary directory is such a path (`/var` -> `/private/var`), which is how this was
// found, and a project under a symlinked home or volume is the same case.
//
// The symlink is made HERE rather than relied on from the platform, so this holds on Linux too.
const realRoot = mkdtempSync(join(tmpdir(), 'seed-make-real-'))
const linkRoot = join(mkdtempSync(join(tmpdir(), 'seed-make-link-')), 'project')

mkdirSync(join(realRoot, 'code'), { recursive: true })
writeFileSync(join(realRoot, 'deck.tree'), 'deck @term/probe\n')
writeFileSync(
  join(realRoot, 'code/helper.tree'),
  'task triple\n  take n, like number\n  like number\n  send back\n    call multiply(read(n), code 3)\n',
)
writeFileSync(
  join(realRoot, 'code/use.tree'),
  'load ./helper\n  find triple\n\ntask nine\n  like number\n  send back\n    call triple(code 3)\n',
)

symlinkSync(realRoot, linkRoot)

const linked = compileProject(linkRoot)

ok(
  'a relative import resolves when the project is reached through a symlink',
  linked.failed === 0 && linked.compiled === 2,
  `${linked.compiled} compiled, ${linked.failed} failed: ${linked.errors.join(' | ').slice(0, 200)}`,
)

rmSync(root, { recursive: true, force: true })

console.log(`\nmake: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
