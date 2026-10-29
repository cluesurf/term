// `mark sole` and `mark hide` on a form (term/affine-kinds-0007, decision note/project/term/affine-kinds/decision/001).
// The mill carries each word onto the form definition as a flag, only when it is written. Any other word under a form
// is refused (`unknown-mark`), so a misspelled `mark sloe` cannot build a copyable, forgeable form in silence. On Rust a
// sole form derives no `Clone`, a program that hands its permit on once builds and runs under rustc, and one that
// would need a clone of it fails at the emitter (`sole-cloned`), with the same program unmarked as the control. The
// record-copy analysis TypeScript and Kotlin read refuses to copy a sole value too (`sole-copied`).
// Run: sh tmp/run-term-ts.sh test/compile/sole-hide-marks.ts

import { runDir } from './run-dir'
import { execFileSync, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import { resolve as resolveNames } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { resolveAsync } from '@term/make/code/check/async-resolve'
import { simplify } from '@term/make/code/ir/simplify'
import { expandTemplates } from '@term/make/code/compile/template'
import { extendForms } from '@term/make/code/check/extend'
import { disambiguateOverloads } from '@term/make/code/check/overload'
import { emitRust } from '@term/make/code/compile/rust'
import { emitTypeScript } from '@term/make/code/compile/typescript'
import type { Program } from '@term/make/code/compile/node'

let pass = 0
let fail = 0
let skip = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

function have(tool: string): boolean {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' })

    return true
  } catch {
    return false
  }
}

type Milled =
  | { ok: true; program: Program }
  | { ok: false; messages: string[] }

function milled(text: string): Milled {
  const parsed = parse({ file: 'main.tree', text })

  if (!parsed.ok) {
    return {
      ok: false,
      messages: parsed.diagnostics.map(d => d.message),
    }
  }

  const built = mill(expandTemplates(parsed.tree), 'main.tree')

  return built.ok
    ? { ok: true, program: built.program }
    : { ok: false, messages: built.diagnostics.map(d => d.message) }
}

function frontEnd(text: string, entries: string[]): Program {
  const built = milled(text)

  if (!built.ok) {
    throw new Error(`mill: ${built.messages.join(' | ')}`)
  }

  const out = extendForms(built.program, 'main.tree', []).program
  disambiguateOverloads(out)
  resolveNames(out, 'main.tree')
  const errors = check(out, 'main.tree').filter(
    d => d.severity !== 'warning',
  )

  if (errors.length) {
    throw new Error(`check: ${errors.map(d => d.message).join(' | ')}`)
  }

  resolveAsync(out)

  return simplify(out, new Set(entries))
}

const formOf = (
  program: Program,
  name: string,
): Extract<Program[number], { form: 'record-type' }> | undefined =>
  program.find(
    (n): n is Extract<Program[number], { form: 'record-type' }> =>
      n.form === 'record-type' && n.name === name,
  )

// ---- the flags ----

const PERMIT = (marks: string): string => `form permit
${marks}  link note, like text
  link person, like text
`

{
  const both = milled(PERMIT('  mark hide\n  mark sole\n'))
  const permit = both.ok ? formOf(both.program, 'permit') : undefined
  ok(
    'mill: `mark sole` sets sole on the form',
    permit?.sole === true,
    both.ok ? '' : both.messages.join(' | '),
  )
  ok('mill: `mark hide` sets hide on the form', permit?.hide === true)

  const sole = milled(PERMIT('  mark sole\n'))
  const soleOnly = sole.ok ? formOf(sole.program, 'permit') : undefined
  // a `need false` flag at its default and the flag absent are one value (decision 034 section 2, decision 071): read
  // the value, never the key
  ok(
    'mill: sole alone leaves hide unset',
    soleOnly?.sole === true && (soleOnly.hide ?? false) === false,
  )

  const hide = milled(PERMIT('  mark hide\n'))
  const hideOnly = hide.ok ? formOf(hide.program, 'permit') : undefined
  ok(
    'mill: hide alone leaves sole unset',
    hideOnly?.hide === true && (hideOnly.sole ?? false) === false,
  )

  const plain = milled(PERMIT(''))
  const unmarked = plain.ok
    ? formOf(plain.program, 'permit')
    : undefined
  ok(
    'mill: an unmarked form carries neither flag',
    unmarked !== undefined &&
      (unmarked.sole ?? false) === false &&
      (unmarked.hide ?? false) === false,
  )
}

// ---- unknown-mark ----

{
  const misspelled = milled(PERMIT('  mark sloe\n'))
  ok(
    'mill: `mark sloe` under a form is refused as unknown-mark',
    !misspelled.ok &&
      misspelled.messages.some(
        m => m.includes('unknown-mark') && m.includes('mark sloe'),
      ),
    misspelled.ok ? 'it built' : misspelled.messages.join(' | '),
  )

  const task = milled(PERMIT('  mark async\n'))
  ok(
    'mill: a task mark under a form is refused too',
    !task.ok && task.messages.some(m => m.includes('unknown-mark')),
  )

  // every word the closed list holds still builds, and a documentation `note` is not a mark
  for (const word of ['shared', 'deprecated', 'prop', 'sole', 'hide']) {
    const one = milled(PERMIT(`  mark ${word}\n`))
    ok(
      `mill: \`mark ${word}\` under a form still builds`,
      one.ok,
      one.ok ? '' : one.messages.join(' | '),
    )
  }

  const tagged = milled(
    `form shape\n  mark tag, name kind\n  case circle\n    link radius, like number\n  case dot\n`,
  )
  ok(
    'mill: `mark tag, name kind` still builds',
    tagged.ok,
    tagged.ok ? '' : tagged.messages.join(' | '),
  )

  const textual = milled(
    `form op\n  mark text\n  case plus, text <+>\n  case minus, text <->\n`,
  )
  ok(
    'mill: `mark text` still builds',
    textual.ok,
    textual.ok ? '' : textual.messages.join(' | '),
  )

  const documented = milled(
    `form permit\n  note <Proof that a person may act on a note.>\n  link note, like text\n`,
  )
  ok(
    'mill: a documentation note under a form is no mark',
    documented.ok,
    documented.ok ? '' : documented.messages.join(' | '),
  )
}

// ---- Rust ----

// a permit made once and handed on once: the single use the usage gate allows
const ONCE = (marks: string): string => `form permit
${marks}  link note, like text
  link person, like text

task grant
  take person, like text
  take note, like text
  like permit
  send back
    make permit
      bind note, read note
      bind person, read person

task spend
  take permit, like permit
  like text
  send back, read permit/note

task run
  like text
  save p
    call grant
      text <ada>
      text <n1>
  send back
    call spend
      read p
`

// the same permit handed on twice to a task that owns what it is given (it hands it back), which the usage gate
// refuses before any backend (`sole-reused`, check/sole.ts, test/check/sole-hide.ts). This front end skips that gate
// on purpose, to hold the emitter's own assertion: the first hand-off is not the name's last read, so it would clone
const TWICE = (marks: string): string => `form permit
${marks}  link note, like text
  link person, like text

task keep
  take permit, like permit
  like permit
  send back, read permit

task run
  like text
  save p
    make permit
      bind note, text <n1>
      bind person, text <ada>
  save a
    call keep
      read p
  save b
    call keep
      read p
  send back, read b/note
`

const dir = runDir('term-sole-hide-')

{
  const once = emitRust(
    frontEnd(ONCE('  mark hide\n  mark sole\n'), ['run']),
  )
  const decl =
    once.split('\n').find(line => /struct Permit\b/.test(line)) ?? ''
  const before = once.slice(
    Math.max(0, once.indexOf('struct Permit') - 80),
    once.indexOf('struct Permit'),
  )
  ok('rust: a sole form is a struct', decl !== '', once.slice(0, 400))
  ok(
    'rust: a sole form derives no Clone',
    !/derive\([^)]*Clone/.test(before),
    before,
  )
  ok(
    'rust: nothing clones a permit',
    !/\bp\.clone\(\)|permit\.clone\(\)/.test(once),
  )

  const plain = emitRust(frontEnd(ONCE(''), ['run']))
  const plainBefore = plain.slice(
    Math.max(0, plain.indexOf('struct Permit') - 80),
    plain.indexOf('struct Permit'),
  )
  ok(
    'rust (control): the unmarked form derives Clone',
    /derive\([^)]*Clone/.test(plainBefore),
    plainBefore,
  )

  if (have('rustc')) {
    const main = join(dir, 'once.rs')
    writeFileSync(
      main,
      `${once}\nfn main() { println!("{}", run()); }\n`,
    )

    try {
      execFileSync(
        'rustc',
        ['-A', 'warnings', '-o', join(dir, 'once'), main],
        { stdio: 'pipe' },
      )
      const result = spawnSync(join(dir, 'once'), [], {
        encoding: 'utf8',
      })
      ok(
        'rust: the sole program builds under rustc and reads n1',
        result.status === 0 && result.stdout.trim() === 'n1',
        `exit ${result.status}: ${result.stdout}${result.stderr}`,
      )
    } catch (e) {
      ok(
        'rust: the sole program builds under rustc',
        false,
        String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 800),
      )
    }
  } else {
    skip++
    console.log('skip  rust: rustc build  (rustc not installed)')
  }

  let refused = ''

  try {
    emitRust(frontEnd(TWICE('  mark sole\n'), ['run']))
  } catch (e) {
    refused = String((e as Error).message ?? e)
  }

  ok(
    'rust: a clone of a sole value fails the build at the emitter (sole-cloned)',
    refused.includes('sole-cloned') && refused.includes('permit'),
    refused || 'it built',
  )

  let control = ''

  try {
    control = emitRust(frontEnd(TWICE(''), ['run']))
  } catch (e) {
    control = `threw: ${String(e)}`
  }

  ok(
    'rust (control): the unmarked form is cloned and builds',
    /\bp\.clone\(\)/.test(control) && !control.startsWith('threw'),
    control.slice(0, 300),
  )
}

// ---- the record copies TypeScript and Kotlin read ----

// a task that writes a field of the permit it was passed must work on its own copy (D1), which a sole value refuses
const WRITES = (marks: string): string => `form permit
${marks}  link note, like text

task stamp
  take permit, like permit
  like text
  save permit/note, text <stamped>
  send back, read permit/note

task run
  like text
  save p
    make permit
      bind note, text <n1>
  send back
    call stamp
      read p
`

{
  let refused = ''

  try {
    emitTypeScript(frontEnd(WRITES('  mark sole\n'), ['run']))
  } catch (e) {
    refused = String((e as Error).message ?? e)
  }

  ok(
    'typescript: copying a sole parameter fails the build (sole-copied)',
    refused.includes('sole-copied') && refused.includes('permit'),
    refused || 'it built',
  )

  let control = ''

  try {
    control = emitTypeScript(frontEnd(WRITES(''), ['run']))
  } catch (e) {
    control = `threw: ${String(e)}`
  }

  ok(
    'typescript (control): the unmarked form is copied and builds',
    !control.startsWith('threw'),
    control.slice(0, 300),
  )
}

console.log(
  `\nsole-hide-marks: ${pass} pass, ${fail} fail, ${skip} skipped`,
)

if (fail > 0) {
  process.exit(1)
}
