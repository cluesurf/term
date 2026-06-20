// Incremental query engine test (Tier 2). Proves memoization, demand-driven recompute, automatic dependency tracking,
// backdating (an equal recompute does not invalidate dependents), the durability shortcut, and the signature-firewall
// pattern (a body edit does not re-check callers). Run: npx tsx test/compile/query.ts

import { Database, LOW, HIGH } from '@/code/compile/query'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}`) } else { fail++; console.log(`FAIL  ${name}  ${info}`) }
}

// 1. memoization: a query body runs once across repeated reads
{
  const db = new Database()
  db.setInput('n', 2)
  let runs = 0
  const double = (): number => db.query('double', () => { runs++; return db.input<number>('n') * 2 })
  ok('query computes the value', double() === 4)
  double()
  double()
  ok('query body ran once for repeated reads', runs === 1)
}

// 2. recompute when a dependency input changes
{
  const db = new Database()
  db.setInput('n', 2)
  const double = (): number => db.query('double', () => db.input<number>('n') * 2)
  ok('initial', double() === 4)
  db.setInput('n', 5)
  ok('recomputes after its input changed', double() === 10)
}

// 3. an unrelated input change does not recompute
{
  const db = new Database()
  db.setInput('a', 1)
  db.setInput('b', 100)
  let runs = 0
  const fromA = (): number => db.query('fromA', () => { runs++; return db.input<number>('a') + 1 })
  fromA()
  db.setInput('b', 200) // unrelated
  fromA()
  ok('a query is not recomputed when an unrelated input changes', runs === 1)
}

// 4. backdating: a dependency recomputes but to an equal value, so its dependents are NOT recomputed
{
  const db = new Database()
  db.setInput('text', 'hello world')
  // `wordCount` depends on the text; `report` depends on wordCount
  const wordCount = (): number => db.query('wordCount', () => db.input<string>('text').split(' ').length)
  let reportRuns = 0
  const report = (): string => db.query('report', () => { reportRuns++; return `words: ${wordCount()}` })
  ok('report initial', report() === 'words: 2')
  ok('report ran once', reportRuns === 1)
  // change the text but keep the same word count (2 words) -> wordCount recomputes to an EQUAL value
  db.setInput('text', 'goodbye earth')
  ok('report value still correct', report() === 'words: 2')
  ok('report was NOT recomputed (wordCount backdated to an equal value)', reportRuns === 1)
  // now change the word count -> report must recompute
  db.setInput('text', 'a b c')
  ok('report updates when wordCount actually changes', report() === 'words: 3')
  ok('report recomputed this time', reportRuns === 2)
}

// 5. durability: a HIGH-durability query is not recomputed (nor deep-walked) when a LOW input changes
{
  const db = new Database()
  db.setInput('stdlib', 10, HIGH)
  db.setInput('buffer', 1, LOW)
  let runs = 0
  const fromStdlib = (): number => db.query('fromStdlib', () => { runs++; return db.input<number>('stdlib') * 2 })
  fromStdlib()
  ok('high-durability query computed once', runs === 1)
  // edit the LOW buffer many times: the HIGH query stays valid in O(1) (durability shortcut), never recomputing
  for (let i = 0; i < 5; i++) db.setInput('buffer', i, LOW)
  fromStdlib()
  ok('high-durability query survives low-durability edits without recomputing', runs === 1)
}

// 6. the signature firewall: a caller depends on a callee's SIGNATURE; editing the callee's BODY leaves the caller green
{
  const db = new Database()
  db.setInput('callee.signature', '(n: number): number')
  db.setInput('callee.body', 'return n * 2')
  // checkSignature reads only the signature; checkBody reads both
  const checkSignature = (): string => db.query('checkSig', () => `sig:${db.input<string>('callee.signature')}`)
  let bodyRuns = 0
  const checkBody = (): string => db.query('checkBody', () => { bodyRuns++; return `body:${db.input<string>('callee.signature')}|${db.input<string>('callee.body')}` })
  // the caller only depends on the callee's signature (the firewall)
  let callerRuns = 0
  const checkCaller = (): string => db.query('checkCaller', () => { callerRuns++; return `caller uses ${checkSignature()}` })

  checkBody()
  checkCaller()
  ok('caller checked once initially', callerRuns === 1)
  ok('body checked once initially', bodyRuns === 1)

  // edit only the callee's BODY
  db.setInput('callee.body', 'return n * 3')
  checkBody()
  checkCaller()
  ok('callee body re-checks after a body edit', bodyRuns === 2)
  ok('the caller stays green after a body edit (firewall)', callerRuns === 1)

  // edit the callee's SIGNATURE -> the caller must re-check
  db.setInput('callee.signature', '(n: number): string')
  checkCaller()
  ok('the caller re-checks after a signature edit', callerRuns === 2)
}

console.log(`\nquery: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
