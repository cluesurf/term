// A module binds the same whether it is the build's entry or a module another file loads (term-self-host-001-0294).
// Two passes answered by which file was the entry, or by what else the closure held, and both failed only once
// check/disambiguate.tree and ir/selection.tree were loaded by compile/program-gate.tree:
//
//   a union named like another form's case    ir/selection.tree defines the union `twin-choice` and writes
//                                             `make twin-choice` for parser/diagnostic.tree's case. As the entry its
//                                             union kept its name and the checker built the case; loaded, check/scope
//                                             renamed the union `twin-choice__form` and gave it the construction,
//                                             which no union can be (scope.ts / scope.tree `separateCaseNames`)
//   a lean label under a method shared by a   check/disambiguate.tree writes `set(state/program, at,
//   form name                                 walk-statement(state, top))`. With a `form set` anywhere in the program
//                                             the label was left a label (the callee read as a construction), and once
//                                             `walk-statement` was renamed apart by arity the checker refused it as a
//                                             property of `set` (disambiguate.tree `nest-under-task`)
//
// A record form a file finds by name wins over a case of a union it also imports (decision 049, 0332), both ways too.
//
// Each is built both ways, small, and then the real modules through compile/program-gate-probe.tree, as the entry and
// loaded by another file.
//
// Run: npx tsx test/check/closure-binding.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import type { Source } from '@term/make/code/compile/load'
import { projectResolver } from '@term/call/code/make'
import { projectLeanOf } from '@term/call/code/role-of'

const root = join(process.cwd(), 'deck/make')
const project = projectResolver(root)

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

// `@app/<name>` modules beside the real packages, every file lean
function build(files: Record<string, string>, main: string) {
  const resolve = (path: string, from?: string): Source | undefined =>
    files[path] !== undefined ? { file: `${path.slice('@app/'.length)}.tree`, text: files[path]! } : project(path, from)

  return compile({ file: 'main.tree', text: main }, { resolve, leanOf: () => true, library: true })
}

const said = (result: { ok: boolean; diagnostics: { severity?: string; message: string }[] }): string =>
  result.ok ? 'ok' : result.diagnostics.filter(d => d.severity !== 'warning').map(d => d.message).join(' | ')

// ---- a union named like another form's case ----

const DIAGNOSTIC = `form kind\n  case twin-choice\n  case other\n\ntask diagnose\n  take k, like kind\n  like text\n  back <d>\n`
const SELECTION = `load @app/diagnostic\n  find diagnose\n\nform twin-choice\n  case reference\n  case use\n    link label, like text\n\ntask pick\n  like text\n  save k, make twin-choice\n  back diagnose(k)\n`

{
  const result = build({ '@app/diagnostic': DIAGNOSTIC }, SELECTION)
  ok('a union named like a case: the construction is the case, the file the entry', result.ok, said(result))
}

{
  const main = `load @app/selection\n  find pick\n\ntask run\n  like text\n  back pick()\n`
  const result = build({ '@app/diagnostic': DIAGNOSTIC, '@app/selection': SELECTION }, main)
  ok('a union named like a case: the construction is the case, the file loaded', result.ok, said(result))
}

{
  // a RECORD form named like a case is still built by its own file's construction (check/scope, the pair case)
  const own = `load @app/diagnostic\n  find diagnose\n\nform twin-choice\n  link label, like text\n\ntask pick\n  like text\n  save k\n    make twin-choice\n      bind label, <x>\n  back k/label\n`
  const main = `load @app/own\n  find pick\n\ntask run\n  like text\n  back pick()\n`
  const result = build({ '@app/diagnostic': DIAGNOSTIC, '@app/own': own }, main)
  ok('a record form named like a case: its own file still builds the form', result.ok, said(result))
}

// ---- a RECORD form named like a case the file never imports (term-self-host-001-0295, decision 045) ----
// As the entry the record kept its name and the checker built the case (`kind has no field label`); loaded, it was
// renamed `twin-choice__form` and built. Now the entry's is renamed too, and exported by its written name as well

const OWN_BODY = `form twin-choice\n  link label, like text\n\ntask pick\n  like text\n  save k\n    make twin-choice\n      bind label, <x>\n  back k/label\n`
const OTHER = `load @app/diagnostic\n  find diagnose\n\ntask other\n  like text\n  back <o>\n`

{
  const main = `load @app/other\n  find other\n\nload @app/diagnostic\n  find diagnose\n\n${OWN_BODY}`
  const result = build({ '@app/diagnostic': DIAGNOSTIC, '@app/other': OTHER }, main)
  ok('a record form named like an unimported case: built as the form, the file the entry', result.ok, said(result))
  ok(
    'a record form named like a case: the entry exports it by its written name',
    result.ok && /^export type TwinChoice = TwinChoiceForm$/m.test(result.typescript),
    result.ok ? result.typescript.split('\n').filter(line => line.includes('TwinChoice')).join(' | ') : '',
  )
}

{
  const main = `load @app/other\n  find other\n\n${OWN_BODY}`
  const result = build({ '@app/diagnostic': DIAGNOSTIC, '@app/other': OTHER }, main)
  ok('a record form named like a case only another module loads: built as the form, the file the entry', result.ok, said(result))
}

{
  const main = `load @app/own\n  find pick\n\nload @app/other\n  find other\n\ntask run\n  like text\n  back pick()\n`
  const result = build({ '@app/diagnostic': DIAGNOSTIC, '@app/own': OWN_BODY, '@app/other': OTHER }, main)
  ok('a record form named like an unimported case: built as the form, the file loaded', result.ok, said(result))
}

{
  // no case of the name in the closure: nothing is renamed, and nothing is aliased
  const result = build({}, OWN_BODY)
  ok('a record form no case shares: kept by its name, no alias', result.ok && /\bTwinChoice\b/.test(result.typescript) && !/TwinChoiceForm/.test(result.typescript), said(result))
}

// ---- a case two forms share, the importer's form renamed by what else the closure holds (T-0079, 0310) ----
// view-document builds node.tree's `view` statement and defines its own `view-body` case `view`. Loaded by analyzer.tree,
// whose closure has a case named `statement`, node.tree's form became `statement__form`, so the importer's `find
// statement` no longer matched it by name and the construction was told its own `view-body`

const NODE = `form statement\n  case view\n    link name, like text\n  case other\n`
const DOC = `load @term/base/list\n  find list\n  find push\n\nload @app/node\n  find statement\n\nform view-body\n  case view\n    link value, like text\n  case plain\n\ntask lower\n  like list, like statement\n  save out, make list\n  save made\n    make view\n      bind name, <v>\n  push(out, made)\n  back out\n`
const KINDS = `form analysis-kind\n  mark text\n  case view\n  case code\n\nform held\n  case statement\n    link at, like number\n  case none\n`

{
  const main = `load @app/doc\n  find lower\n\ntask run\n  like number\n  back lower()/length\n`
  const result = build({ '@app/node': NODE, '@app/doc': DOC }, main)
  ok('a shared case built by an importer: told the imported owner, nothing renamed', result.ok, said(result))
}

{
  const main = `load @app/doc\n  find lower\n\n${KINDS}\ntask run\n  like number\n  back lower()/length\n`
  const result = build({ '@app/node': NODE, '@app/doc': DOC }, main)
  ok('a shared case built by an importer: told the imported owner, its form renamed __form by the closure', result.ok, said(result))
}

// ---- a record form found by name beside a union whose case has the name (term-self-host-001-0332, decision 049) ----
// check/inferring-expressions.tree finds node.tree's `expression` (a case `hole`) and part 1's record form `hole`, and
// builds the record. meansForm asked the union import first, so `make hole` built the case ('hole has no field file'),
// as the entry and loaded. A name is scoped to its module: the form the file finds by name is the nearer binding

const EXPR = `form expr\n  case hole\n    link name, like text\n  case other\n\ntask show-expr\n  take e, like expr\n  like text\n  back <e>\n`
const STATE = `form hole\n  link file, like text\n  link count, like number\n\ntask hole-file\n  take h, like hole\n  like text\n  back h/file\n`
const FINDS_BOTH = `load @app/expr\n  find expr\n  find show-expr\n\nload @app/state\n  find hole\n  find hole-file\n\ntask made\n  like text\n  save h\n    make hole\n      bind file, <a>\n      bind count, 1\n  back hole-file(h)\n`
// the union alone imported: its case is still what `make hole` builds
const FINDS_UNION = `load @app/expr\n  find expr\n  find show-expr\n\nload @app/state\n  find hole-file\n\ntask made\n  like text\n  save e\n    make hole\n      bind name, <n>\n  back show-expr(e)\n`
const LOADS_MADE = `load @app/user\n  find made\n\ntask run\n  like text\n  back made()\n`

{
  const result = build({ '@app/expr': EXPR, '@app/state': STATE }, FINDS_BOTH)
  ok('a record form found by name beside a union with its case: built as the form, the file the entry', result.ok, said(result))
}

{
  const result = build({ '@app/expr': EXPR, '@app/state': STATE, '@app/user': FINDS_BOTH }, LOADS_MADE)
  ok('a record form found by name beside a union with its case: built as the form, the file loaded', result.ok, said(result))
}

{
  const result = build({ '@app/expr': EXPR, '@app/state': STATE }, FINDS_UNION)
  ok('the union alone found, the record form in the closure: built as the case, the file the entry', result.ok, said(result))
}

{
  const result = build({ '@app/expr': EXPR, '@app/state': STATE, '@app/user': FINDS_UNION }, LOADS_MADE)
  ok('the union alone found, the record form in the closure: built as the case, the file loaded', result.ok, said(result))
}

// ---- a lean label under a method a form shares its name with ----

const WALKING = `load @term/base/list\n  find list\n\nform walk-state\n  link program, like list, like number\n\ntask walk-statement\n  take state, like walk-state\n  take x, like number\n  like number\n  mark private\n  back x\n\ntask swap\n  take xs, like list, like number\n  like list, like number\n  save state\n    make walk-state\n      bind program, xs\n  set(state/program, 0, walk-statement(state, 1))\n  back state/program\n`
// another module's `walk-statement` at another arity, so both are renamed apart by arity
const OTHER_WALK = `task walk-statement\n  take x, like text\n  take y, like text\n  take z, like text\n  like text\n  mark private\n  back x\n\ntask other-walk\n  like text\n  back walk-statement(<o>, <p>, <q>)\n`
// a form named like list's method `set`
const SET_FORM = `form set\n  link x, like number\n\ntask make-set\n  like number\n  save s\n    make set\n      bind x, 1\n  back s/x\n`

{
  const result = build({ '@app/other': OTHER_WALK, '@app/set': SET_FORM }, `load @app/other\n  find other-walk\n\nload @app/set\n  find make-set\n\n${WALKING}\ntask run\n  like text\n  make-set()\n  back other-walk()\n`)
  ok('a label under a method a form shares: nested, the file the entry', result.ok, said(result))
}

{
  const main = `load @app/walking\n  find swap\n\nload @app/other\n  find other-walk\n\nload @app/set\n  find make-set\n\ntask run\n  take xs, like list, like number\n  like text\n  swap(xs)\n  make-set()\n  back other-walk()\n`
  const result = build({ '@app/walking': WALKING, '@app/other': OTHER_WALK, '@app/set': SET_FORM }, main)
  ok('a label under a method a form shares: nested, the file loaded', result.ok, said(result))
}

// ---- the real modules: check/disambiguate and ir/selection beside compile/rolling's closure ----

const PROBE = join(root, 'code/compile/program-gate-probe.tree')

{
  const result = compile({ file: PROBE, text: readFileSync(PROBE, 'utf8') }, { resolve: project, leanOf: projectLeanOf(root), library: true })
  ok('compile/program-gate-probe.tree builds as the entry', result.ok, said(result))
}

{
  const file = join(root, 'code/compile/program-gate-probe-loader.tree')
  const text = `load ./program-gate-probe\n  find probe-gate\n\nload ./node\n  find statement\n  find twin\n\nload ./import-scope\n  find file-scope\n\ntask probe-loaded\n  take program, like list, like statement\n  take scopes, like list, like file-scope\n  take twins, like list, like twin\n  like list, like statement\n\n  back probe-gate(program, scopes, twins)\n`
  const result = compile({ file, text }, { resolve: project, leanOf: projectLeanOf(root), library: true })
  ok('compile/program-gate-probe.tree builds loaded by another file', result.ok, said(result))
}

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
