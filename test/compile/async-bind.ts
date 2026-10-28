// A `bind` may say `mark async` (decision 053 of note/project/term/self-host/change/001-finish-self-host): its host
// code answers a promise, and a call to it is then waited exactly like a call to an async task. Until 2026-10-28 a bind
// could not say so, the promise was typed `like dynamic`, and a field read off it compiled to a read of the promise
// (`term make --merged` stopped on "entries is not iterable", traps.md T-0334). This holds the waited read, the refused
// unwaited read (a tick's job, a call outside every task), and the missing mark caught where the build can tell: a
// field read off the promise of an unmarked bind whose text answers one by its shape (check/missing-wait.ts).
// Run: npx tsx test/compile/async-bind.ts

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOn } from './shared/run-on'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'

const ROOT = join(import.meta.dirname, '..', '..')

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

const run = (program: string): { output: string; emitted: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'async-bind-'))
  const ran = runOn({ backend: 'typescript', program, resolve: env => projectResolver(ROOT, env, ROOT), dir, name: 'bind' })
  const output = ran.form === 'ran' ? ran.output : `${ran.form}: ${ran.reason.slice(0, 600)}`
  let emitted = ''

  try {
    emitted = readFileSync(join(dir, 'bind-typescript.ts'), 'utf8')
  } catch {}

  return { output, emitted }
}

// the refusals of a program that should not build, or BUILT
const refusals = (text: string): string => {
  const result = compile({ file: join(ROOT, 'tmp/async-bind.tree'), text }, { resolve: projectResolver(ROOT, 'node', ROOT), leanOf: () => true })

  return result.ok ? 'BUILT' : result.diagnostics.filter(d => d.severity !== 'warning').map(d => `${d.name}: ${d.message}`).join(' | ')
}

const answer = `form answer
  link problems, like list, like text
`

// a bind whose host code answers a promise of an answer with two problems, marked or not, the mark where `where` says
const answerLater = (where: 'none' | 'before' | 'after'): string => `${answer}
bind answer-later
${where === 'before' ? '  mark async\n' : ''}  like dynamic
${where === 'after' ? '  mark async\n' : ''}  case node
    text <Promise.resolve(\\{ problems: ["a", "b"] \\})>
`

// ---- a marked bind is waited like an async task ----

const direct = run(`${answerLater('before')}
task count-problems
  like number
  save result, answer-later()
  back result/problems/length

task run
  like text
  back <{count-problems()}>
`)
ok('a field read off a marked bind\'s answer reads the answer', direct.output === '2', direct.output)
ok('the call is written awaited', /await Promise\.resolve\(/.test(direct.emitted), direct.emitted.slice(0, 800))
ok('its caller becomes async, and the caller of that', /async function countProblems/.test(direct.emitted) && /async function run/.test(direct.emitted), direct.emitted.slice(0, 800))

const after = run(`${answerLater('after')}
task run
  like text
  save result, answer-later()
  back <{result/problems/length}>
`)
ok('`mark async` may follow the bind\'s like, as on a task', after.output === '2', after.output)

const through = run(`${answerLater('before')}
task start-answer
  like dynamic
  back answer-later()

task run
  like text
  save result, start-answer()
  back <{result/problems/length}>
`)
ok('a plain task handing the marked bind\'s answer back is async, and its caller reads the answer (the T-0334 shape)', through.output === '2', through.output)

const written = run(`${answerLater('before')}
task run
  like text
  save result
    call answer-later
      wait true
  back <{result/problems/length}>
`)
ok('a written wait on the call reads and means the same', written.output === '2', written.output)

const ticked = refusals(`load @term/base/task
  find handle

${answerLater('before')}
task run
  like number
  save job, tick answer-later()
  back job/problems/length
`)
ok('a tick of a marked bind is its pending job, so a field of the answer read off it is refused', /"handle" has no field "problems"/.test(ticked), ticked)

const outside = refusals(`${answerLater('before')}
host found, answer-later()
`)
ok('outside every task an unticked call to a marked bind is refused, naming tick', /async-outside-task|tick/.test(outside) && outside !== 'BUILT', outside)

// ---- the missing mark, caught where the build can tell ----

const unmarked = refusals(`${answerLater('none')}
task count-problems
  like number
  save result, answer-later()
  back result/problems/length
`)
ok('a field read off an unmarked bind whose text answers a promise is refused as missing-wait', /missing-wait: "problems" is read off the promise/.test(unmarked), unmarked)

const viaTask = refusals(`${answerLater('none')}
task start-answer
  like dynamic
  back answer-later()

task count-problems
  like number
  mark async
  save result, start-answer()
  back result/problems/length
`)
ok('and through a plain task that hands it back', /missing-wait: "problems" is read off the promise/.test(viaTask), viaTask)

const chained = refusals(`${answer}
bind answer-later
  like dynamic
  case node
    text <import("node:fs").then((m) =\\> (\\{ problems: [] \\}))>

task count-problems
  like number
  back answer-later()/problems/length
`)
ok('a text ending in a .then chain is known to answer a promise', /missing-wait/.test(chained), chained)

const handed = refusals(`${answerLater('none')}
bind settle-count
  take promise, like dynamic
  like dynamic
  case node
    text <$promise.then((x) =\\> x.problems.length)>

task count-problems
  like dynamic
  mark async
  save result, answer-later()
  back wait settle-count(result)
`)
ok('an unmarked promise handed on as a value to more host code builds', handed === 'BUILT', handed)

const unknown = refusals(`${answer}
bind answer-later
  take make-one, like dynamic
  like dynamic
  case node
    text <$make-one()>

task count-problems
  take make-one, like dynamic
  like number
  save result, answer-later(make-one)
  back result/problems/length
`)
ok('a text whose shape does not say it answers a promise is the mark\'s to say (the stated gap)', unknown === 'BUILT', unknown)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
