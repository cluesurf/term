// A name belongs to the module that defines it, and reaches another module only through `load ... / find`
// (note/term/project/module-scope.md). These are the cases the one flat program used to get wrong, each built as a small
// package of modules: two definitions of one name in two files, and a file that imports one of them.
//
//   module-scope-0002  tasks of DIFFERENT signatures across files are bound by import, not chosen as global overloads
//
// Run: npx tsx test/check/module-scope.ts

import { compile } from '@term/make/code/compile/compile'
import type { Source } from '@term/make/code/compile/load'
import { projectResolver } from '@term/call/code/make'

// the real packages, for a component's dom and render runtime
const projectResolve = projectResolver(process.cwd(), 'node')

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

// a package of `@app/<name>` modules, and a main file loading some of them
function build(files: Record<string, string>, main: string) {
  const resolve = (path: string): Source | undefined =>
    files[path] !== undefined ? { file: `${path.slice('@app/'.length)}.tree`, text: files[path]! } : undefined

  return compile({ file: 'main.tree', text: main }, { resolve })
}

const said = (result: ReturnType<typeof build>): string =>
  result.ok ? result.typescript : result.diagnostics.map(d => d.message).join(' | ')

// two modules define `pick` at DIFFERENT parameter types: over text, and over numbers
const PICK_TEXT = `task pick\n  take x, like text\n  like text\n  send back, text <text>\n`
const PICK_NUMBER = `task pick\n  take x, like number\n  like text\n  send back, text <number>\n`

{
  // main imports the text one and calls it with text: it is the text one
  const main = `load @app/a\n  find pick\n\nload @app/b\n  find other\n\ntask run\n  like text\n  send back\n    call pick\n      text <x>\n`
  const b = `${PICK_NUMBER}\ntask other\n  like text\n  send back, text <o>\n`
  const result = build({ '@app/a': PICK_TEXT, '@app/b': b }, main)
  ok('a call binds to the definition its file imported', result.ok && /"text"/.test(result.typescript), said(result))
}

{
  // main imports the TEXT one and calls it with a NUMBER. The flat program chose the number one by type, a module main
  // never imported; bound by import, it is the text one, and a number does not fit it
  const main = `load @app/a\n  find pick\n\nload @app/b\n  find other\n\ntask run\n  like text\n  send back\n    call pick\n      code 3\n`
  const b = `${PICK_NUMBER}\ntask other\n  like text\n  send back, text <o>\n`
  const result = build({ '@app/a': PICK_TEXT, '@app/b': b }, main)
  ok(
    'a call never reaches a same-named task of another type its file did not import',
    !result.ok || !/"number"/.test(result.typescript),
    said(result),
  )
  ok('the argument that does not fit the imported one is refused', !result.ok, said(result))
}

// two modules define `pick` at DIFFERENT arities
const PICK_ONE = `task pick\n  take x, like text\n  like text\n  send back, text <one>\n`
const PICK_TWO = `task pick\n  take x, like text\n  take y, like text\n  like text\n  send back, text <two>\n`

{
  // main imports the one-parameter pick and calls it with two arguments: refused against the imported one, never the
  // other module's two-parameter pick, which the flat program's arity overloading reached
  const main = `load @app/a\n  find pick\n\nload @app/b\n  find other\n\ntask run\n  like text\n  send back\n    call pick\n      text <x>\n      text <y>\n`
  const b = `${PICK_TWO}\ntask other\n  like text\n  send back, text <o>\n`
  const result = build({ '@app/a': PICK_ONE, '@app/b': b }, main)
  ok('a call with an arity only the unimported module takes does not reach it', !result.ok || !/"two"/.test(result.typescript), said(result))
}

{
  // a call whose file imports the name from NEITHER, where only one module's definitions take its arity: it still binds
  // to that one, as it always has, until the strict step (module-scope-0006) refuses an unimported reference
  const main = `load @app/a\n  find other\n\nload @app/b\n  find another\n\ntask run\n  like text\n  send back\n    call pick\n      text <x>\n      text <y>\n`
  const a = `${PICK_ONE}\ntask other\n  like text\n  send back, text <o>\n`
  const b = `${PICK_TWO}\ntask another\n  like text\n  send back, text <p>\n`
  const result = build({ '@app/a': a, '@app/b': b }, main)
  ok('an unimported call that only one module\'s arity takes still binds to it', result.ok && /"two"/.test(result.typescript), said(result))
}

{
  // a task passed as a VALUE is bound by its file's import too
  const main = `load @app/a\n  find pick\n\nload @app/b\n  find other\n\ntask apply\n  take f\n    like task\n      take x, like text\n      like text\n  like text\n  send back\n    call f\n      text <x>\n\ntask run\n  like text\n  send back\n    call apply\n      read pick\n`
  const b = `${PICK_NUMBER}\ntask other\n  like text\n  send back, text <o>\n`
  const result = build({ '@app/a': PICK_TEXT, '@app/b': b }, main)
  ok('a task passed as a value is the one its file imported', result.ok && !/"number"/.test(result.typescript), said(result))
}

{
  // the entry file defines `pick` itself, and so does a module it loads for something else: the entry's keeps its name,
  // which is what its exported API is called
  const main = `load @app/b\n  find other\n\n${PICK_TEXT}\ntask run\n  like text\n  send back\n    call pick\n      text <x>\n\ntask run-other\n  like text\n  send back, call other\n`
  const b = `${PICK_NUMBER}\ntask other\n  like text\n  send back, call pick(code 1)\n`
  const result = build({ '@app/b': b }, main)
  ok('the entry file\'s own definition keeps its name', result.ok && /export function pick\(/.test(result.typescript), said(result))
  ok('and the other module\'s call reaches its own', result.ok && /"number"/.test(result.typescript), said(result))
}

// module-scope-0003: two FORMS of one name in two files, each with fields of its own and a method of its own
const POINT_A = `form point\n  link x, like number\n  link y, like number\n  task total\n    take self, like point\n    like number\n    send back\n      call add\n        read self/x\n        read self/y\n`
const POINT_B = `form point\n  link lat, like text\n  link long, like text\n  task total\n    take self, like point\n    like text\n    send back\n      read self/lat\n`
// c builds b's point, so b's form is in the program beside a's
const POINT_C = `load @app/b\n  find point\n\ntask place\n  like text\n  save p\n    make point\n      bind lat, text <north>\n      bind long, text <west>\n  send back, read p/lat\n`

{
  // main imports a's point and builds it with a's fields, c builds b's with b's: both are in one program, apart
  const main = `load @app/a\n  find point\n\nload @app/c\n  find place\n\ntask run\n  like number\n  save p\n    make point\n      bind x, code 1\n      bind y, code 2\n  send back, read p/x\n\ntask run-place\n  like text\n  send back, call place\n`
  const result = build({ '@app/a': POINT_A, '@app/b': POINT_B, '@app/c': POINT_C }, main)
  ok('two forms of one name in two files compile side by side, each importer building its own', result.ok, said(result))
}

{
  // a's form's method reaches a's form, b's reaches b's: the method follows its form when the form is split
  const main = `load @app/a\n  find point\n\nload @app/c\n  find place\n\ntask run\n  like number\n  save p\n    make point\n      bind x, code 1\n      bind y, code 2\n  send back\n    call total\n      read p\n\ntask run-place\n  like text\n  send back, call place\n`
  const result = build({ '@app/a': POINT_A, '@app/b': POINT_B, '@app/c': POINT_C }, main)
  ok('a form\'s method follows its own form', result.ok, said(result))
}

{
  // main imports `point` from BOTH: it gets the one the flat program let win among them, the one merged last (b's),
  // as the generated bind package relies on, until the strict step (module-scope-0006) refuses it
  const main = `load @app/a\n  find point\n\nload @app/b\n  find point\n\ntask run\n  like text\n  save p\n    make point\n      bind lat, text <n>\n      bind long, text <w>\n  send back, read p/lat\n`
  const result = build({ '@app/a': POINT_A, '@app/b': POINT_B }, main)
  ok('a form imported from two definers is the one merged last, as the flat program had it', result.ok, said(result))
}

{
  // main names `point` but imports it from neither: it gets the one the flat program let win, the one merged last, so
  // nothing that builds today stops building (the strict step, module-scope-0006, refuses it)
  const main = `load @app/c\n  find place\n\nload @app/a\n  find other\n\ntask run\n  take p, like point\n  like number\n  send back, code 1\n\ntask run-place\n  like text\n  send back, call place\n`
  const a = `${POINT_A}\ntask other\n  like number\n  send back, code 1\n`
  const result = build({ '@app/a': a, '@app/b': POINT_B, '@app/c': POINT_C }, main)
  ok('an unimported form reference still builds, as the flat program built it', result.ok, said(result))
}

// module-scope-0004: two COMPONENTS of one name in two files, each drawing its own element
const BADGE_A = `load @term/site/code/dom/dom\n  find view\n\nview badge\n  take host, like view\n  view span\n    text <a>\n`
const BADGE_B = `load @term/site/code/dom/dom\n  find view\n\nview badge\n  take host, like view\n  view em\n    text <b>\n`
// d places b's badge, so b's component is in the program beside a's
const BADGE_D = `load @term/site/code/dom/dom\n  find view\n\nload @app/b\n  find badge\n\nview card\n  take host, like view\n  view badge\n`

{
  const main = `load @term/site/code/dom/dom\n  find view\n\nload @app/a\n  find badge\n\nload @app/d\n  find card\n\nview page\n  take host, like view\n  view badge\n  view card\n`
  const files = { '@app/a': BADGE_A, '@app/b': BADGE_B, '@app/d': BADGE_D }
  // the app's modules by name, everything else (the dom, and the render runtime with its relative loads) from the real
  // packages, resolved from the file that asked
  const resolve = (path: string, from: string): Source | undefined =>
    files[path as keyof typeof files] !== undefined
      ? { file: `${path.slice('@app/'.length)}.tree`, text: files[path as keyof typeof files] }
      : projectResolve(path, from)
  const result = compile({ file: 'main.tree', text: main }, { resolve })
  ok('two components of one name in two files compile side by side', result.ok, said(result))
  // page places a's badge (a span), card places b's (an em): both elements are drawn
  ok('each placement draws the component its file imported', result.ok && /"span"/.test(result.typescript) && /"em"/.test(result.typescript), said(result))
}

// module-scope-0005: ONE NAME, TWO KINDS, told apart by where it stands. A task `point` and a form `point`, each from its
// own module, both imported with a plain `find` and no alias
const TASK_POINT = `task point\n  take x, like number\n  like number\n  send back\n    call add\n      read x\n      code 10\n`
const FORM_POINT = `form point\n  link x, like number\n  link total, like number\n  task sum\n    take self, like point\n    like number\n    send back\n      read self/x\n`

{
  const main = `load @app/t\n  find point\n\nload @app/f\n  find point\n\ntask run\n  like number\n  save p, like point\n    make point\n      bind x, code 1\n      bind total, code 5\n  send back\n    call point\n      read p/x\n`
  const result = build({ '@app/t': TASK_POINT, '@app/f': FORM_POINT }, main)
  ok('a task and a form of one name, both imported plainly, compile with no alias', result.ok, said(result))
  ok('`call point` is the task and `make point` / `like point` the form', result.ok && /\+ 10|10\)/.test(result.typescript), said(result))
}

// a top-level task named like a FIELD and like a METHOD of a form, from a module the file never imported for it
const TOTAL_TASK = `task total\n  take n, like number\n  like number\n  send back, code 99\n\ntask sum\n  take n, like number\n  like number\n  send back, code 98\n`

{
  // `read p/total` reads the field, whatever task some other module calls `total`
  const main = `load @app/f\n  find point\n\nload @app/g\n  find other\n\ntask run\n  like number\n  save p, like point\n    make point\n      bind x, code 1\n      bind total, code 5\n  send back, read p/total\n`
  const g = `${TOTAL_TASK}\ntask other\n  like number\n  send back\n    call total\n      code 1\n`
  const result = build({ '@app/f': FORM_POINT, '@app/g': g }, main)
  ok('a field read is the field, not a same-named task of another module', result.ok && !/99/.test(result.typescript), said(result))
}

{
  // `call sum, read p` on a point is the form's own method, not a same-named top-level task of another module
  // (native-dom-0036: a top-level task shadowed every same-named method)
  const main = `load @app/f\n  find point\n\nload @app/g\n  find other\n\ntask run\n  like number\n  save p, like point\n    make point\n      bind x, code 7\n      bind total, code 5\n  send back\n    call sum\n      read p\n`
  const g = `${TOTAL_TASK}\ntask other\n  like number\n  send back\n    call sum\n      code 1\n`
  const result = build({ '@app/f': FORM_POINT, '@app/g': g }, main)
  ok('a method call on a value is its form\'s method, not a same-named task of another module', result.ok && !/98/.test(result.typescript), said(result))
}

{
  // a record matched under its OWN name binds its fields in the arm, and a field named like a task of the file is the
  // field there: `case mark / link start / read start` beside a top-level `task start`
  // (deck/base/code/native/node/clock/measurement.tree)
  const main = `form mark\n  link start, like number\n\ntask start\n  like mark\n  send back\n    make mark\n      bind start, code 3\n\ntask since\n  take m, like mark\n  like number\n  fork case, read m\n    case mark\n      link start\n      send back\n        call subtract\n          code 10\n          read start\n`
  const result = build({}, main)
  ok('a field bound by a record\'s own arm is the field, not a same-named task', result.ok, said(result))
}

// a `host` VALUE in one module and a TASK of the same name in another (terminal-target-0003: the terminal host's
// `host focus` beside the memory dom's `task focus`). Both reached the output as declarations of one name, and the
// bundle refused to load. `read level/n` is the value and `call level` the task, so each keeps its own
const GAUGE = `form gauge\n  mark shared\n  link n, like number\n\nhost level\n  make gauge\n    bind n, code 4\n\ntask read-level\n  like number\n  send back, read level/n\n`
const LEVEL_TASK = `task level\n  take n, like number\n  like number\n  send back\n    call add\n      read n\n      code 100\n`

{
  const main = `load @app/v\n  find read-level\n\nload @app/t\n  find level\n\ntask run\n  like number\n  send back\n    call add\n      call read-level\n      call level\n        code 1\n`
  const result = build({ '@app/v': GAUGE, '@app/t': LEVEL_TASK }, main)
  const declared = result.ok ? (result.typescript.match(/(?:const|let|var|function) level\b/g) ?? []).length : -1
  ok('a host value and a same-named task of another module compile side by side', result.ok, said(result))
  // at most once: the optimizer may inline the task, and two is what the collision produced
  ok('the output never declares the name twice: the value has its own', declared >= 0 && declared <= 1, `${declared} declarations of "level"`)
  ok('the value reference still reads the host', result.ok && /level__value\d*\.n|levelValue\d*\.n/.test(result.typescript), said(result))
}

// the ENTRY file's task keeps its name beside another module's task of the same name at another arity. An abstract
// module's signature (no body, as deck/site/code/base/native/db.tree declares `run`) is not split by file, so the two
// were mangled by arity, and the entry's `run` was emitted as `run0`: its host found no `run` to call
// (terminal-target-0005)
const RUN_SIGNATURE = `task run\n  take sql, like text\n  take params, like text\n  like text\n`

{
  const main = `load @app/sig\n  find run\n\ntask run\n  like text\n  send back, text <done>\n\ntask other\n  like text\n  send back\n    call run\n      text <a>\n      text <b>\n`
  const result = build({ '@app/sig': RUN_SIGNATURE }, main)
  ok('an entry task and an imported signature of one name at two arities compile', result.ok, said(result))
  ok('the entry\'s task keeps its own name', result.ok && /function run\(\)/.test(result.typescript), said(result))
  ok('the other arity is still told apart', result.ok && !/function run\(sql/.test(result.typescript), said(result))
}

// an import ALIAS of a name the file also defines. `find measure, name module-measure` is rewritten to the imported
// name before binding, so the file's own `measure` took it and the call was checked against the wrong task: the float
// port's `find to-number, name decimal-to-number` bound to its own `to-number` (self-hosting, 2026-10-04). Each output
// is run, so an inlined call is held to its answer rather than its spelling
const MEASURE_MODULE = `task measure\n  take x, like number\n  like text\n  send back, text <module>\n`

async function runOf(typescript: string): Promise<Record<string, () => unknown>> {
  const { transformSync } = await import('esbuild')
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const file = join(mkdtempSync(join(tmpdir(), 'term-module-scope-')), 'module.mjs')
  writeFileSync(file, transformSync(typescript, { loader: 'ts', format: 'esm' }).code)

  return (await import(pathToFileURL(file).href)) as Record<string, () => unknown>
}

{
  const main = `load @app/m\n  find measure, name module-measure\n\nform box\n  link n, like number\n\ntask measure\n  take b, like box\n  like text\n  send back, text <own>\n\ntask run\n  like text\n  send back\n    call module-measure\n      code 3\n\ntask mine\n  like text\n  save b\n    make box\n      bind n, code 1\n  send back\n    call measure\n      read b\n`
  const result = build({ '@app/m': MEASURE_MODULE }, main)
  ok('an aliased import of a name the file defines compiles', result.ok, said(result))

  if (result.ok) {
    const mod = await runOf(result.typescript)
    ok('the alias reaches the imported task', mod.run?.() === 'module', String(mod.run?.()))
    ok('the bare name is still the file\'s own', mod.mine?.() === 'own', String(mod.mine?.()))
  }
}

// and the same where the imported name is a native BINDING, as the stdlib's `bind to-number` is: a `bind` is not split
// by file the way a task is, so it needed its own pass (bindAliasedNatives)
const MEASURE_NATIVE = `bind measure\n  take x, like number\n  like number\n  case node\n    text <($x + 100)>\n`

{
  const main = `load @app/n\n  find measure, name native-measure\n\nform box\n  link n, like number\n\ntask measure\n  take b, like box\n  like number\n  send back, code 7\n\ntask run\n  like number\n  send back\n    call native-measure\n      code 3\n\ntask mine\n  like number\n  save b\n    make box\n      bind n, code 1\n  send back\n    call measure\n      read b\n`
  const result = build({ '@app/n': MEASURE_NATIVE }, main)
  ok('an aliased import of a native binding the file names a task compiles', result.ok, said(result))

  if (result.ok) {
    const mod = await runOf(result.typescript)
    ok('the alias reaches the native binding', mod.run?.() === 103, String(mod.run?.()))
    ok('the bare name is still the file\'s own task', mod.mine?.() === 7, String(mod.mine?.()))
  }
}

// an alias keeps two same-named FORMS apart: `element` from one module, `find element, name chart-element` from
// another. The bridge dropped the alias on a `make` and a `like`, and form binding reached a bare name through every
// find of it, so both spellings bound to the form merged last and `make element, bind name` failed as needing `size`
// (guides: language/modules, 2026-10-04)
{
  const page = `form element\n  link name, like text\n`
  const chart = `form element\n  link size, like number\n`
  const main = `load @app/page\n  find element\n\nload @app/chart\n  find element, name chart-element\n\ntask title\n  like text\n  save e\n    make element\n      bind name, text <title>\n  send back, read e/name\n\ntask bar\n  take c, like chart-element\n  like number\n  send back, read c/size\n\ntask run\n  like number\n  save c\n    make chart-element\n      bind size, code 3\n  send back\n    call bar\n      read c\n`
  const result = build({ '@app/page': page, '@app/chart': chart }, main)
  ok('an alias keeps two same-named forms apart, in a `make` and in a `like`', result.ok, said(result))

  if (result.ok) {
    const mod = await runOf(result.typescript)
    ok('the bare name builds the first module\'s form', mod.title?.() === 'title', String(mod.title?.()))
    ok('the alias builds and takes the second\'s', mod.run?.() === 3, String(mod.run?.()))
  }
}

// two same-named TASKS from two modules in one file, one under an alias: `json`'s and `csv`'s `parse`, `time`'s and
// `clock`'s `now`. The guides said the build refused it as `duplicate-definition`; on 2026-10-04 it built, each name
// reaching its own module, and this holds it
{
  const json = `task parse\n  take text, like text\n  like text\n  send back, text <json>\n`
  const csv = `task parse\n  take text, like text\n  like text\n  send back, text <csv>\n`
  const main = `load @app/json\n  find parse\n\nload @app/csv\n  find parse, name parse-csv\n\ntask both\n  like text\n  send back, <{parse(<a>)}{parse-csv(<b>)}>\n`
  const result = build({ '@app/json': json, '@app/csv': csv }, main)
  ok('one file loads two same-named tasks, one under an alias', result.ok, said(result))

  if (result.ok) {
    const mod = await runOf(result.typescript)
    ok('each name reaches its own module', mod.both?.() === 'jsoncsv', String(mod.both?.()))
  }
}

// an exception form named like another form's case is renamed apart (`clash__form`), and so are its raises. The arm of
// a match over the caught exception was not, so it named nothing, and its fields were unknown names: that is how
// check/pattern-literal.tree's `case pattern-mismatch` failed once parser/diagnostic.tree's case of the name was in the
// program (2026-10-05)
{
  const fault = `load @term/base/exception\n  find exception\n\nform clash\n  like exception\n    bind note, <Clashed>\n    link at, like number\n\ntask fail-it\n  like number\n  halt clash\n    bind at, code 7\n`
  const names = `form label\n  mark text\n  case clash\n  case other\n`
  // main imports the case's form too: an arm still means the exception it imports by name
  const main = `load @app/fault\n  find clash\n  find fail-it\n\nload @app/names\n  find label\n\ntask run\n  like number\n  mark unsafe\n    call fail-it\n    send back, code 0\n  halt take\n    take error\n    sift error\n      case clash\n        send back, read at\n    send back, code -1\n`
  const files = { '@app/fault': fault, '@app/names': names }
  const resolve = (path: string, from: string): Source | undefined =>
    files[path as keyof typeof files] !== undefined
      ? { file: `${path.slice('@app/'.length)}.tree`, text: files[path as keyof typeof files] }
      : projectResolve(path, from)
  const result = compile({ file: 'main.tree', text: main }, { resolve })
  ok('an arm over a caught exception reaches a form renamed apart from a case', result.ok, said(result))

  if (result.ok) {
    const mod = await runOf(result.typescript)
    ok('the arm catches it and reads its field', mod.run?.() === 7, String(mod.run?.()))
  }
}

console.log(`\nmodule-scope: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
