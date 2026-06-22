// Incremental query engine test (Tier 2), async edition. Proves memoization, demand-driven recompute, automatic
// dependency tracking, backdating (an equal recompute does not invalidate dependents), the durability shortcut, and
// the signature-firewall pattern. Plus the async additions: in-flight dedup, cycle detection, and that concurrent
// (interleaved) evaluation produces the same recompute counts as serial. Run: npx tsx test/compile/query.ts

import { Database, LOW, HIGH } from '@cluesurf/make/code/compile/query'
import type { Cx } from '@cluesurf/make/code/compile/query'

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

async function main(): Promise<void> {
  // 1. memoization: a query body runs once across repeated reads
  {
    const db = new Database()
    db.setInput('n', 2)

    let runs = 0

    const double = (): Promise<number> =>
      db.evaluate('double', cx => {
        runs++

        return cx.input<number>('n') * 2
      })

    ok('query computes the value', (await double()) === 4)
    await double()
    await double()
    ok('query body ran once for repeated reads', runs === 1)
  }

  // 2. recompute when a dependency input changes
  {
    const db = new Database()
    db.setInput('n', 2)

    const double = (): Promise<number> =>
      db.evaluate('double', cx => cx.input<number>('n') * 2)

    ok('initial', (await double()) === 4)
    db.setInput('n', 5)
    ok('recomputes after its input changed', (await double()) === 10)
  }

  // 3. an unrelated input change does not recompute
  {
    const db = new Database()
    db.setInput('a', 1)
    db.setInput('b', 100)

    let runs = 0

    const fromA = (): Promise<number> =>
      db.evaluate('fromA', cx => {
        runs++

        return cx.input<number>('a') + 1
      })

    await fromA()
    db.setInput('b', 200) // unrelated
    await fromA()
    ok(
      'a query is not recomputed when an unrelated input changes',
      runs === 1,
    )
  }

  // 4. backdating: a dependency recomputes but to an equal value, so its dependents are NOT recomputed
  {
    const db = new Database()
    db.setInput('text', 'hello world')

    const wordCount = (cx: Cx): Promise<number> =>
      cx.query(
        'wordCount',
        c => c.input<string>('text').split(' ').length,
      )

    let reportRuns = 0

    const report = (): Promise<string> =>
      db.evaluate('report', async cx => {
        reportRuns++

        return `words: ${await wordCount(cx)}`
      })

    ok('report initial', (await report()) === 'words: 2')
    ok('report ran once', reportRuns === 1)
    db.setInput('text', 'goodbye earth') // same word count (2) -> wordCount backdates
    ok('report value still correct', (await report()) === 'words: 2')
    ok(
      'report was NOT recomputed (wordCount backdated to an equal value)',
      reportRuns === 1,
    )
    db.setInput('text', 'a b c') // now the word count changes
    ok(
      'report updates when wordCount actually changes',
      (await report()) === 'words: 3',
    )
    ok('report recomputed this time', reportRuns === 2)
  }

  // 5. durability: a HIGH-durability query is not recomputed (nor deep-walked) when a LOW input changes
  {
    const db = new Database()
    db.setInput('stdlib', 10, HIGH)
    db.setInput('buffer', 1, LOW)

    let runs = 0

    const fromStdlib = (): Promise<number> =>
      db.evaluate('fromStdlib', cx => {
        runs++

        return cx.input<number>('stdlib') * 2
      })

    await fromStdlib()
    ok('high-durability query computed once', runs === 1)

    for (let i = 0; i < 5; i++) {db.setInput('buffer', i, LOW)}

    await fromStdlib()
    ok(
      'high-durability query survives low-durability edits without recomputing',
      runs === 1,
    )
  }

  // 6. the signature firewall: a caller depends on a callee's SIGNATURE; editing the callee's BODY leaves the caller green
  {
    const db = new Database()
    db.setInput('callee.signature', '(n: number): number')
    db.setInput('callee.body', 'return n * 2')

    const checkSignature = (cx: Cx): Promise<string> =>
      cx.query(
        'checkSig',
        c => `sig:${c.input<string>('callee.signature')}`,
      )

    let bodyRuns = 0

    const checkBody = (): Promise<string> =>
      db.evaluate('checkBody', cx => {
        bodyRuns++

        return `body:${cx.input<string>('callee.signature')}|${cx.input<string>('callee.body')}`
      })

    let callerRuns = 0

    const checkCaller = (): Promise<string> =>
      db.evaluate('checkCaller', async cx => {
        callerRuns++

        return `caller uses ${await checkSignature(cx)}`
      })

    await checkBody()
    await checkCaller()
    ok('caller checked once initially', callerRuns === 1)
    ok('body checked once initially', bodyRuns === 1)

    db.setInput('callee.body', 'return n * 3') // edit only the body
    await checkBody()
    await checkCaller()
    ok('callee body re-checks after a body edit', bodyRuns === 2)
    ok(
      'the caller stays green after a body edit (firewall)',
      callerRuns === 1,
    )

    db.setInput('callee.signature', '(n: number): string') // edit the signature
    await checkCaller()
    ok('the caller re-checks after a signature edit', callerRuns === 2)
  }

  // 7. in-flight dedup: two concurrent requests for one slow key run its body once
  {
    const db = new Database()
    db.setInput('x', 3)

    let runs = 0

    const slow = (): Promise<number> =>
      db.evaluate('slow', async cx => {
        runs++

        const v = cx.input<number>('x')
        await new Promise(r => setTimeout(r, 5))

        return v * 10
      })

    const [a, b] = await Promise.all([slow(), slow()])
    ok('concurrent requests get the same value', a === 30 && b === 30)
    ok(
      'the slow body ran once for two concurrent requests (in-flight dedup)',
      runs === 1,
    )
  }

  // 8. cycle detection: a query that transitively requests itself throws rather than hanging
  {
    const db = new Database()
    db.setInput('seed', 1)

    let threw = false

    try {
      await db.evaluate('loop', cx =>
        cx.query('loop', c => c.input<number>('seed')),
      )
    } catch {
      threw = true
    }

    ok('a self-requesting query throws a cycle error', threw)
  }

  // 9. concurrency vs serial: interleaved evaluation produces the same recompute counts as serial evaluation
  {
    const build = async (concurrent: boolean): Promise<number> => {
      const db = new Database()
      db.setInput('base', 1, HIGH)

      const leaf = (cx: Cx, i: number): Promise<number> =>
        cx.query(`leaf:${i}`, c => c.input<number>('base') + i)

      const roots = [0, 1, 2, 3, 4]
      const run = (): Promise<number[]> =>
        db.transaction(async cx => {
          const jobs = roots.map(i =>
            cx.query(`root:${i}`, async c => (await leaf(c, i)) * 2),
          )

          return concurrent ? Promise.all(jobs) : serial(jobs)
        })

      await run()
      await run() // second pass: everything memoized, no recompute

      return db.recomputes
    }

    const serial = async (ps: Promise<number>[]): Promise<number[]> => {
      const out: number[] = []

      for (const p of ps) {out.push(await p)}

      return out
    }

    const serialCount = await build(false)
    const concurrentCount = await build(true)
    ok(
      'concurrent evaluation recomputes exactly as many times as serial',
      serialCount === concurrentCount,
      `${serialCount} vs ${concurrentCount}`,
    )
  }

  console.log(`\nquery: ${pass} pass, ${fail} fail`)

  if (fail > 0) {process.exit(1)}
}

void main()
