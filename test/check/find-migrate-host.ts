// term:find-migrate's proof for a HOST DESCRIPTION (@term/bind, decision 002 of note/project/term/module-scope). There
// an unimported type binds to nothing and is erased, so a right `find` changes the emitted type: a find is accepted
// when the file builds after, its own diagnostics fall by exactly the `unknown-name` warnings of the found names with
// nothing new, and its TypeScript with types stripped is identical (task/term/find-migrate.ts `typeOnly`).
//
// Run: npx tsx test/check/find-migrate-host.ts

import type { Source } from '@term/make/code/compile/load'
import { projectResolver } from '@term/call/code/make'
import * as loaded from '../../../../../../task/term/find-migrate'

// a script outside the package loads as CommonJS, whose exports arrive under `default`
const tool = ((loaded as { default?: typeof loaded }).default ?? loaded) as typeof loaded
const { chooseDefiner, describesHost, emit, typeOnly } = tool

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

const FILES: Record<string, string> = {
  '@app/shapes': ['form shape', '  link size, like number', ''].join('\n'),
  '@app/other': ['form other', '  link mass, like number', ''].join('\n'),
}

function build(text: string, deck: string) {
  const resolve = (path: string, from: string): Source | undefined =>
    FILES[path] !== undefined ? { file: `${path.slice('@app/'.length)}.tree`, text: FILES[path]! } : projectResolve(path, from)

  return emit('main.tree', text, { host: true, options: { resolve, deckOf: () => ({ name: deck, root: '/' }) } })
}

// a signature with no body, as every bind task is (a stub). `like shape <arguments>` is the type as written
const body = (shape: string): string[] => ['task measure', `  take s, like ${shape}`, '  like number', '']

// the type with no find: a warning in a host description, and the parameter's type erased
const before = build(body('shape').join('\n'), '@term/bind')
ok('a host description builds an unknown type with a warning', before.ok && before.notes.some(note => note.includes('"shape"')), JSON.stringify(before))
ok('the same file outside one is refused', !build(body('shape').join('\n'), '@term/base').ok)
ok('the compiler names @term/bind a host description', describesHost('@term/bind'))
ok('and not @term/base', !describesHost('@term/base'))

// the found form: the type changes, nothing that runs does
const found = build(['load @app/shapes', '  find shape', '', ...body('shape')].join('\n'), '@term/bind')
ok('the find builds', found.ok, JSON.stringify(found))
ok('and changes the emitted type', before.ok && found.ok && before.ts !== found.ts)
ok('a find of the form is a type-only change', typeOnly(before, found, ['shape']) === undefined, String(typeOnly(before, found, ['shape'])))
ok('but not one that answers a name not found', typeOnly(before, found, ['other']) !== undefined)

// a find that makes a new error: its relative load reaches no file, which fails the build at the load. (A form found
// with the wrong number of type arguments, or found twice, builds today, so neither can stand for an error here)
const weightBefore = build(body('shape').join('\n'), '@term/bind')
const weightAfter = build(['load ./no-such-module', '  find shape', '', ...body('shape')].join('\n'), '@term/bind')
const weightWhy = typeOnly(weightBefore, weightAfter, ['shape'])
ok('a find that adds an error is refused', weightBefore.ok && weightWhy !== undefined && weightWhy.startsWith('does not build after'), `${String(weightWhy)} ${JSON.stringify(weightBefore).slice(0, 200)}`)

// a find through a module that does not define the name: a new diagnostic
const stale = build(['load @app/other', '  find shape', '', ...body('shape')].join('\n'), '@term/bind')
ok('a find from a module that lacks the name is refused', typeOnly(before, stale, ['shape']) !== undefined, String(typeOnly(before, stale, ['shape'])))

// rule 2: the file's own platform tree, then shared/, then outside the package
const code = '/x/bind/code'
const pick = (file: string, definers: string[]): string => {
  const choice = chooseDefiner(code, file, definers)

  return 'definer' in choice ? choice.definer : 'by hand'
}

ok('one definer is that one', pick(`${code}/node/a.tree`, [`${code}/rust/r.tree`]) === `${code}/rust/r.tree`)
ok('the own tree first', pick(`${code}/rust/a.tree`, [`${code}/shared/m.tree`, `${code}/rust/std/r.tree`, '/x/base/code/r.tree']) === `${code}/rust/std/r.tree`)
ok('then shared', pick(`${code}/node/a.tree`, [`${code}/shared/m.tree`, '/x/base/code/m.tree']) === `${code}/shared/m.tree`)
ok('then outside the package', pick(`${code}/node/a.tree`, [`${code}/rust/m.tree`, '/x/base/code/m.tree']) === '/x/base/code/m.tree')
ok('two in one tree are by hand', pick(`${code}/node/a.tree`, [`${code}/node/m.tree`, `${code}/node/n.tree`]) === 'by hand')

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail > 0 ? 1 : 0
