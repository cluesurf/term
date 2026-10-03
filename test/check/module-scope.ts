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
  // main imports `point` from BOTH: refused, naming both files (a type has no arity to tell two forms apart)
  const main = `load @app/a\n  find point\n\nload @app/b\n  find point\n\ntask run\n  take p, like point\n  like number\n  send back, code 1\n`
  const result = build({ '@app/a': POINT_A, '@app/b': POINT_B }, main)
  const message = said(result)
  ok('a form imported from two files that define it is refused', !result.ok && /form "point"/.test(message), message)
  ok('the refusal names both files', message.includes('a.tree') && message.includes('b.tree'), message)
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

console.log(`\nmodule-scope: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
