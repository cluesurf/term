// A unit shared between projects imports what each of them has (note/term/plan/incremental-best-in-class.md, steps 1
// and 13). The standard library's units are built once for the machine, and their emitted imports name the modules they
// load. Those names were relative to the project root, so a unit one project built named files a project at another
// depth never wrote. Two projects at different depths here share one store, and every relative import either one
// emits must name a module beside it.
// Run: npx tsx test/compile/unit-imports.ts

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSession, compileProjectSeparate } from '@term/call/code/make'
import { sharedCacheStore } from '@term/call/code/cache-store'
import { CompileCache } from '@term/make/code/compile/cache'

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

const base = realpathSync(mkdtempSync(join(tmpdir(), 'unit-imports-')))
const shared = join(base, 'shared')

// the same program, one directory deep and three
const project = (name: string, at: string): string => {
  const root = join(base, at)
  mkdirSync(join(root, 'code'), { recursive: true })
  writeFileSync(join(root, 'deck.tree'), `deck @probe/${name}\n  mark <0.0.1>\n`)
  writeFileSync(join(root, 'code', 'base.tree'), `load @term/base/text\n  find trim\n\nload @term/base/list\n  find sort\n\ntask ${name}\n  like text\n  back trim(< ${name} >)\n`)

  return root
}

const build = (root: string) =>
  compileProjectSeparate(root, new CompileCache(sharedCacheStore(join(root, '.base/cache'), shared, 'probe'), 'probe'), 'node', buildSession(root))

// every `from "./x"` in host/.unit that names no file there
const dangling = (root: string): string[] => {
  const dir = join(root, 'host', '.unit')

  return readdirSync(dir).flatMap(name =>
    [...readFileSync(join(dir, name), 'utf8').matchAll(/from ["']\.\/([^"']+)["']/g)]
      .map(found => found[1]!)
      .filter(target => !existsSync(join(dir, `${target}.ts`)))
      .map(target => `${name} -> ${target}`),
  )
}

const shallow = project('shallow', 'one')
const deep = project('deep', 'one/two/three')

const first = build(shallow)
ok('the shallow project builds', first.failed === 0, first.errors.join(' | '))

const second = build(deep)
ok('the deep project builds', second.failed === 0, second.errors.join(' | '))
ok('reading the standard library units the shallow one built', second.built === 1, `${second.built} built`)

ok('every import the shallow project emits names a module it has', dangling(shallow).length === 0, dangling(shallow).slice(0, 3).join(', '))
ok('every import the deep project emits names a module it has', dangling(deep).length === 0, dangling(deep).slice(0, 3).join(', '))

console.log(`\nunit-imports: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
