// Seed lint-plugin test: load a rule authored in `.tree`, run it through the engine, and assert it fires. Proves the
// plugin architecture end to end: a rule is ordinary Seed, loaded with no edit to the driver. Run: npx tsx
// test/lint/seed-rule.ts

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@/code/parser/tree'
import { mill } from '@/code/compile/mill'
import { withNativeEnv } from '@/code/compile/native'
import { lint } from '@/code/lint/lint'
import { loadSeedRules } from '@/code/lint/seed-rule'
import type { Source } from '@/code/compile/load'

const here = dirname(fileURLToPath(import.meta.url))
const seedRoot = resolvePath(here, '..', '..')
const baseTree = resolvePath(seedRoot, '..', 'base.tree')

const stdlib = (path: string): Source | undefined => {
  const prefix = '@cluesurf/base/'
  if (!path.startsWith(prefix)) return undefined
  const file = join(baseTree, `${path.slice(prefix.length)}.tree`)
  return existsSync(file)
    ? { file, text: readFileSync(file, 'utf8') }
    : undefined
}
const readRuntime = (path: string): string | undefined => {
  const prefix = '@cluesurf/base/'
  if (!path.startsWith(prefix)) return undefined
  const file = join(baseTree, path.slice(prefix.length))
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

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

const resolve = withNativeEnv('node', stdlib)
const rules = await loadSeedRules(
  join(seedRoot, 'rule'),
  resolve,
  readRuntime,
)
ok('a Seed rule directory loads as plugins', rules.length >= 1)
ok(
  'the loaded rule keeps its name and code',
  rules.some(r => r.name === 'no-redundant-arithmetic' && r.code === 'L003'),
)

// `call add / read x / mark 0` mills to a binary `+` with a zero literal — the L003 case
const offending = `task compute
  take x, like number
  like number
  send back
    call add
      read x
      mark 0
`
const parsed = parse({ file: 'main.tree', text: offending })
const built = parsed.ok ? mill(parsed.tree, 'main.tree') : undefined
const findings =
  built && built.ok
    ? lint(built.program, 'main.tree', offending, {}, rules)
    : []
ok(
  'the Seed rule fires L003 on redundant arithmetic',
  findings.some(f => f.code === 'L003'),
  JSON.stringify(findings),
)

// a clean program raises nothing
const clean = `task compute
  take x, like number
  like number
  send back
    call add
      read x
      mark 2
`
const cleanParsed = parse({ file: 'main.tree', text: clean })
const cleanBuilt = cleanParsed.ok
  ? mill(cleanParsed.tree, 'main.tree')
  : undefined
const cleanFindings =
  cleanBuilt && cleanBuilt.ok
    ? lint(cleanBuilt.program, 'main.tree', clean, {}, rules)
    : []
ok(
  'the Seed rule stays quiet on a non-neutral operand',
  cleanFindings.every(f => f.code !== 'L003'),
  JSON.stringify(cleanFindings),
)

console.log(`\nseed-rule: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
