// One unit cache for the machine (note/term/plan/incremental-best-in-class.md, step 1). A unit's key is its content
// and the surfaces it reaches, never which project asked, so the standard library's units one project builds answer
// every other project's first build. Two projects here, each with its own local cache and one shared store between
// them, as `projectCache` lays them out (`~/.base/@term/code/base` for the shared kinds).
// Run: npx tsx test/compile/unit-shared.ts

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileSeparate } from '@term/make/code/compile/separate'
import { CompileCache } from '@term/make/code/compile/cache'
import { sharedCacheStore } from '@term/call/code/cache-store'
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

const shared = mkdtempSync(join(tmpdir(), 'unit-shared-'))

// a project of one file loading the standard library's list and text modules
const project = (name: string): { root: string; file: string; text: string } => {
  const root = mkdtempSync(join(tmpdir(), `unit-${name}-`))
  mkdirSync(join(root, 'code'), { recursive: true })
  writeFileSync(join(root, 'deck.tree'), `deck @probe/${name}\n  mark <0.0.1>\n`)
  const text = `load @term/base/list\n  find sort\n\nload @term/base/text\n  find trim\n\ntask ${name}\n  like text\n  back trim(< ${name} >)\n`
  const file = join(root, 'code', 'base.tree')
  writeFileSync(file, text)

  return { root, file, text }
}

const build = (one: { root: string; file: string; text: string }) => {
  const cache = new CompileCache(sharedCacheStore(join(one.root, '.base/cache'), shared, 'probe'), 'probe')
  const result = compileSeparate({ file: one.file, text: one.text }, { resolve: projectResolver(one.root), cache, modules: f => `./${f}` })

  return { result, cache }
}

const first = build(project('first'))
ok('the first project builds', first.result.ok, first.result.ok ? '' : first.result.diagnostics.map(d => d.message).join(' | '))

const second = build(project('second'))
ok('the second project builds', second.result.ok, second.result.ok ? '' : second.result.diagnostics.map(d => d.message).join(' | '))

if (first.result.ok && second.result.ok) {
  const stdlib = (labels: string[]) => labels.filter(label => label.includes('/deck/base/'))
  const builtFirst = stdlib(first.result.built)
  const builtSecond = stdlib(second.result.built)
  const reusedSecond = stdlib(second.result.reused)

  ok('the first project built the standard library units it reaches', builtFirst.length > 0, `${builtFirst.length}`)
  ok('the second project built none of them', builtSecond.length === 0, builtSecond.slice(0, 3).join(', '))
  ok('it read every one from the shared store', reusedSecond.length === builtFirst.length, `${reusedSecond.length} of ${builtFirst.length}`)
  ok('from disk, not from memory', second.cache.diskHits >= builtFirst.length, `${second.cache.diskHits} disk hits`)
  ok('and built only its own module', second.result.built.length === 1, second.result.built.join(', '))
}

console.log(`\nunit-shared: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
