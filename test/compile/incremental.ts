// Incremental front-end test (Tier 2). The query-engine-driven compiler: editing one module re-mills only it, a
// comment-only edit backdates (the merged program is not rebuilt), and a real edit rebuilds. Run: npx tsx test/compile/incremental.ts

import { QueryCompiler } from '@/code/compile/incremental'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}`) } else { fail++; console.log(`FAIL  ${name}  ${info}`) }
}

const A = 'a.tree'
const B = 'b.tree'
const aV1 = `task a-value\n  like number\n  send back\n    mark 1\n`
const bV1 = `task b-value\n  like number\n  send back\n    mark 2\n`

const qc = new QueryCompiler()
qc.setSource(A, aV1)
qc.setSource(B, bV1)

// initial compile
const first = qc.program([A, B])
ok('merges both modules', first.ok && first.program.length === 2, first.ok ? '' : 'failed')
const afterFirst = qc.db.recomputes

// re-running with no edits recomputes nothing (everything verified at the current revision)
qc.program([A, B])
ok('a no-op recompile does no work', qc.db.recomputes === afterFirst, `delta ${qc.db.recomputes - afterFirst}`)

// a COMMENT-only edit to A: source changes, but the milled AST does not -> mill backdates, the merged program is NOT
// rebuilt. parse + mill of A re-run (2), but the `program` query stays green.
const before = qc.db.recomputes
qc.setSource(A, `# just a comment\n${aV1}`)
const afterComment = qc.program([A, B])
ok('comment-only edit keeps the program correct', afterComment.ok && afterComment.program.length === 2)
const commentDelta = qc.db.recomputes - before
ok('comment-only edit re-runs only parse + mill of A, not the merged program', commentDelta === 2, `delta ${commentDelta}`)

// a REAL edit to A: the milled AST changes -> the merged program rebuilds (parse + mill + program = 3)
const before2 = qc.db.recomputes
qc.setSource(A, `task a-value\n  like number\n  send back\n    mark 99\n`)
const afterReal = qc.program([A, B])
ok('real edit rebuilds the program', afterReal.ok)
const realDelta = qc.db.recomputes - before2
ok('real edit re-runs parse + mill + the merged program', realDelta === 3, `delta ${realDelta}`)

// editing A does not re-mill B (B is reused across the edit)
const before3 = qc.db.recomputes
qc.setSource(A, `task a-value\n  like number\n  send back\n    mark 7\n`)
qc.program([A, B])
const onlyADelta = qc.db.recomputes - before3
ok('editing A never re-mills the unchanged B', onlyADelta === 3, `delta ${onlyADelta}`)

// ---- the signature firewall on real definitions ----
// a module with three functions: `caller` calls `helper`, `other` is independent. Editing helper's BODY must not
// re-check caller (it depends on helper's SIGNATURE). Editing helper's SIGNATURE must re-check caller.
{
  const X = 'x.tree'
  const callerSrc = `task caller\n  like number\n  send back\n    call helper\n      mark 5\n`
  const otherSrc = `task other\n  like number\n  send back\n    mark 0\n`
  const withHelper = (helper: string): string => `${helper}\n${callerSrc}\n${otherSrc}`
  const helperV1 = `task helper\n  take n, like number\n  like number\n  send back\n    read n\n`

  const fw = new QueryCompiler()
  const files = [X]
  fw.setSource(X, withHelper(helperV1))

  ok('finds the three definitions', fw.defNames(files).join(',') === 'caller,helper,other')
  for (const n of fw.defNames(files)) fw.checkDef(files, n)
  ok('caller resolves its call to the defined helper', fw.checkDef(files, 'caller').unresolved.length === 0)
  const callerRuns = fw.db.runs('checkDef:caller')
  const helperRuns = fw.db.runs('checkDef:helper')

  // edit helper BODY only (signature unchanged)
  fw.setSource(X, withHelper(`task helper\n  take n, like number\n  like number\n  send back\n    mark 42\n`))
  for (const n of fw.defNames(files)) fw.checkDef(files, n)
  ok('editing the callee BODY re-checks the callee', fw.db.runs('checkDef:helper') === helperRuns + 1)
  ok('editing the callee BODY does NOT re-check the caller (firewall)', fw.db.runs('checkDef:caller') === callerRuns)

  // edit helper SIGNATURE (param type number -> text)
  fw.setSource(X, withHelper(`task helper\n  take n, like text\n  like number\n  send back\n    mark 42\n`))
  for (const n of fw.defNames(files)) fw.checkDef(files, n)
  ok('editing the callee SIGNATURE re-checks the caller', fw.db.runs('checkDef:caller') === callerRuns + 1)

  // editing an unrelated definition (other) never re-checks caller
  const callerRuns2 = fw.db.runs('checkDef:caller')
  fw.setSource(X, withHelper(`task helper\n  take n, like text\n  like number\n  send back\n    mark 42\n`).replace('mark 0', 'mark 1'))
  for (const n of fw.defNames(files)) fw.checkDef(files, n)
  ok('editing an unrelated definition does NOT re-check the caller', fw.db.runs('checkDef:caller') === callerRuns2)
}

// ---- functional per-definition resolve (real resolve, firewalled) ----
{
  const X = 'r.tree'
  const otherSrc = `task other\n  like number\n  send back\n    mark 0\n`
  const callerSrc = `task caller\n  like number\n  send back\n    call helper\n      mark 5\n`
  const withHelper = (helper: string): string => `${helper}\n${callerSrc}\n${otherSrc}`
  const helperV1 = `task helper\n  take n, like number\n  like number\n  send back\n    read n\n`

  const rc = new QueryCompiler()
  const files = [X]
  rc.setSource(X, withHelper(helperV1))

  // caller's call to helper resolves cleanly (real resolver, on a clone)
  const caller = rc.resolvedDef(files, 'caller')
  ok('resolvedDef: a valid call resolves with no diagnostics', caller.diagnostics.length === 0, JSON.stringify(caller.diagnostics))
  ok('resolvedDef: returns a resolved definition', caller.def?.name === 'caller')
  for (const n of rc.defNames(files)) rc.resolvedDef(files, n)
  const callerRuns = rc.db.runs('resolved:caller')

  // edit helper BODY: caller must NOT be re-resolved (its source + the name set are unchanged)
  rc.setSource(X, withHelper(`task helper\n  take n, like number\n  like number\n  send back\n    mark 9\n`))
  for (const n of rc.defNames(files)) rc.resolvedDef(files, n)
  ok('resolvedDef: editing the callee body does NOT re-resolve the caller', rc.db.runs('resolved:caller') === callerRuns)
  ok('resolvedDef: the callee is re-resolved', rc.db.runs('resolved:helper') >= 2)

  // a real unknown-name error is reported, per definition
  rc.setSource(X, withHelper(`task helper\n  take n, like number\n  like number\n  send back\n    call missing-fn\n      read n\n`))
  const broken = rc.resolvedDef(files, 'helper')
  ok('resolvedDef: an undefined call is reported (real resolver diagnostic)', broken.diagnostics.length > 0, JSON.stringify(broken.diagnostics.map(d => d.name)))
  ok('resolvedDef: an unrelated function stays clean', rc.resolvedDef(files, 'other').diagnostics.length === 0)
}

// ---- functional per-definition type-checking (real infer) ----
{
  const X = 't.tree'
  const otherSrc = `task other\n  like number\n  send back\n    mark 0\n`
  // caller passes a number to helper (which takes a number): well-typed
  const callerSrc = `task caller\n  like number\n  send back\n    call helper\n      mark 5\n`
  const withHelper = (helper: string): string => `${helper}\n${callerSrc}\n${otherSrc}`
  const helperOk = `task helper\n  take n, like number\n  like number\n  send back\n    read n\n`

  const tc = new QueryCompiler()
  const files = [X]
  tc.setSource(X, withHelper(helperOk))

  const caller = tc.typedDef(files, 'caller')
  ok('typedDef: a well-typed function checks clean (real inference)', caller.diagnostics.length === 0, JSON.stringify(caller.diagnostics.map(d => d.name)))
  const callerType = structureKeyOf(caller.def)

  // edit helper BODY (signature unchanged): caller's typed result is structurally identical -> its dependents firewall
  tc.setSource(X, withHelper(`task helper\n  take n, like number\n  like number\n  send back\n    call multiply\n      read n\n      mark 2\n`))
  const caller2 = tc.typedDef(files, 'caller')
  ok('typedDef: a callee body edit leaves the caller typed-result unchanged (firewall via backdating)', structureKeyOf(caller2.def) === callerType)

  // a real TYPE ERROR in one function is detected by real inference (helper returns text but is declared number)
  tc.setSource(X, withHelper(`task helper\n  take n, like number\n  like number\n  send back\n    text <oops>\n`))
  const broken = tc.typedDef(files, 'helper')
  ok('typedDef: a real type mismatch is reported (real inference, per definition)', broken.diagnostics.some(d => d.name === 'type-mismatch'), JSON.stringify(broken.diagnostics.map(d => d.name)))
  ok('typedDef: an unrelated function stays clean under the error', tc.typedDef(files, 'other').diagnostics.length === 0)
}

// ---- per-definition emit (stage 3) ----
{
  const X = 'e.tree'
  const otherSrc = `task other\n  like number\n  send back\n    mark 0\n`
  const callerSrc = `task caller\n  like number\n  send back\n    call helper\n      mark 5\n`
  const withHelper = (helper: string): string => `${helper}\n${callerSrc}\n${otherSrc}`
  const helperV1 = `task helper\n  take n, like number\n  like number\n  send back\n    read n\n`

  const ec = new QueryCompiler()
  const files = [X]
  ec.setSource(X, withHelper(helperV1))

  const emitted = ec.emitProgram(files)
  ok('emitProgram emits every function', /function caller/.test(emitted) && /function helper/.test(emitted) && /function other/.test(emitted), emitted.slice(0, 120))
  const callerEmit = ec.emitDef(files, 'caller')
  const callerEmitRuns = ec.db.runs('emit:caller')

  // edit helper BODY: caller (and other) must NOT be re-emitted (the emit-level firewall)
  ec.setSource(X, withHelper(`task helper\n  take n, like number\n  like number\n  send back\n    call multiply\n      read n\n      mark 2\n`))
  ec.emitProgram(files)
  ok('emitDef: editing the callee body does NOT re-emit the caller', ec.db.runs('emit:caller') === callerEmitRuns)
  ok('emitDef: the callee is re-emitted', ec.db.runs('emit:helper') >= 2)
  ok('emitDef: the caller emit is unchanged', ec.emitDef(files, 'caller') === callerEmit)
}

console.log(`\nincremental: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)

// span-free structural key, mirroring the compiler's backdating equality (for test assertions)
function structureKeyOf(value: unknown): string {
  return JSON.stringify(value, (k, v) => (k === 'span' ? undefined : v))
}
