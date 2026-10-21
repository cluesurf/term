// A claim whose type calls a task of ANOTHER file, in the separate (per-unit) build (term-proof-0011). The kernel proves
// such a claim by running the task's body (term-proof-0004), and in a unit build the task is a stub: before the fix
// the stub carried no body, so `term make` refused the claim (`unverified-proof`, the type it states never computed)
// where `term hold` and `term make --merged` proved it. test/assurance/notes was the case: 17 claims of law.tree over
// model.tree's tasks. A unit some proving unit reaches now carries the bodies of its pure tasks shown to end
// (compile/separate.ts `underProof`, compile/stub.ts `stubProgram`), and only such a unit gives up the early cutoff.
// Run: npx tsx test/compile/claim-across-units.ts

import { compileSeparate } from '@term/make/code/compile/separate'
import { CompileCache } from '@term/make/code/compile/cache'
import type { Resolver } from '@term/make/code/compile/load'

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

// the model: a form, and a pure task over it shown to end (two statements, so its body is no shape a stub keeps)
const MODEL = `form flag
  case yes
  case no

task flip
  take g, like flag
  like flag
  save h, read g
  sift h
    case yes
      send back, make no
    case no
      send back, make yes
`

// the same task, its body written another way and meaning the same
const MODEL_EDIT = `form flag
  case yes
  case no

task flip
  take g, like flag
  like flag
  save k, read g
  save h, read k
  sift h
    case yes
      send back, make no
    case no
      send back, make yes
`

const EQUAL = `form equal
  head a
  head x, like a
  head y, like a
  case refl
    link c, like a
    head
      read c
    head
      read c
`

// the law, in another file: flip twice is the flag you started with, proven by computing `flip`
const LAW = `load ./model
  find flag
  find flip

${EQUAL}
rule flip-twice
  take g, like flag
  like equal flag
    head
      flip(flip(g))
    head
      read g

task flip-twice
  take g
  sift g
    case yes
      send back
        make refl
          bind c, make yes
    case no
      send back
        make refl
          bind c, make no
`

// its false twin: flip once is the flag you started with
const FALSE_LAW = LAW.replace('      flip(flip(g))', '      flip(g)')

// a file that only calls the task, with no rule anywhere: its build keeps the early cutoff
const USER = `load ./model
  find flag
  find flip

task use
  take g, like flag
  like flag
  send back, flip(g)
`

function resolver(model: string): Resolver {
  return path => (path === './model' ? { file: 'model.tree', text: model } : undefined)
}

const slug = (file: string): string => `./${file.replace(/\.tree$/, '').replace(/\W/g, '_')}.mjs`

const build = (entry: string, model: string, cache: CompileCache) =>
  compileSeparate({ file: 'entry.tree', text: entry }, { resolve: resolver(model), cache, modules: slug })

const codes = (result: ReturnType<typeof build>): string[] => (result.ok ? [] : result.diagnostics.map(d => d.name))

const proofCache = new CompileCache()
const proven = build(LAW, MODEL, proofCache)
ok('a claim over a task of another file is proven in the unit build', proven.ok, JSON.stringify(codes(proven)))

const refused = build(FALSE_LAW, MODEL, new CompileCache())
ok(
  'its false twin is refused by the kernel, not for want of the body',
  !refused.ok && refused.diagnostics.some(d => d.name === 'unverified-proof' && /does not check against its claim/.test(d.message)),
  JSON.stringify(refused.ok ? [] : refused.diagnostics.map(d => d.message.slice(0, 200))),
)

// under a proof a body edit reaches the proof, which ran the old body: the law is checked again
const edited = build(LAW, MODEL_EDIT, proofCache)
ok(
  'under a proof, a body edit rebuilds the proving unit',
  edited.ok && edited.built.includes('entry.tree'),
  JSON.stringify(edited.ok ? { built: edited.built, reused: edited.reused } : codes(edited)),
)

// under no proof the early cutoff holds as before: the body edit rebuilds the model alone
const plainCache = new CompileCache()
const plain = build(USER, MODEL, plainCache)
ok('a caller with no rule builds', plain.ok, JSON.stringify(codes(plain)))
const plainEdit = build(USER, MODEL_EDIT, plainCache)
ok(
  'under no proof, a body edit is cut off at the stub',
  plainEdit.ok && plainEdit.built.join(',') === 'model.tree' && plainEdit.reused.join(',') === 'entry.tree',
  JSON.stringify(plainEdit.ok ? { built: plainEdit.built, reused: plainEdit.reused } : codes(plainEdit)),
)

console.log(`\nclaim-across-units: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
