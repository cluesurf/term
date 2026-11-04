// The pair runner's diff never overflows the stack on a huge answer (traps.md T-0272, term-self-host-001-0304). Run
// from anywhere:
//
//   npx tsx task/term/pair-diff-check.ts
//
// Four cases of task/term/pair/canon.ts unifiedDiff: a small diff keeps its hunk form; a hunk of 260,000 lines under
// DIFF_LIMIT (which overflowed `out.push(header, ...body)`) comes back whole; two texts past DIFF_LIMIT come back as
// digests, sizes, the first differing path and the first differing line; equal texts give the empty text. Prints
// `pair-diff: N pass, M fail` and exits 1 on any failure.

import { createHash } from 'node:crypto'
import { DIFF_LIMIT, unifiedDiff } from './pair/canon'

let pass = 0
let fail = 0

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    pass++
  } else {
    fail++
    console.log(`FAIL ${name}: ${detail}`)
  }
}

function run(name: string, body: () => string): string | undefined {
  try {
    return body()
  } catch (error) {
    check(name, false, `threw ${(error as Error).name}: ${(error as Error).message}`)
    return undefined
  }
}

function lines(prefix: string, n: number): string {
  const out: string[] = []

  for (let i = 0; i < n; i++) out.push(`${prefix}${i}`)

  return `${out.join('\n')}\n`
}

// 1. a small diff keeps the unified form
const small = run('small', () => unifiedDiff('a\nb\nc\n', 'a\nx\nc\n', 'original', 'port', '$.b'))

if (small !== undefined) {
  check(
    'small',
    small === '--- original\n+++ port\n@@ -1,3 +1,3 @@\n a\n-b\n+x\n c\n',
    JSON.stringify(small),
  )
}

// 2. a hunk of 260,000 changed lines under the limit: every line comes back, nothing overflows
const hunkLeft = lines('a', 130_000)
const hunkRight = lines('b', 130_000)

check('hunk-size', hunkLeft.length <= DIFF_LIMIT && hunkRight.length <= DIFF_LIMIT, 'inputs past DIFF_LIMIT')

const hunk = run('hunk', () => unifiedDiff(hunkLeft, hunkRight, 'original', 'port'))

if (hunk !== undefined) {
  const shown = hunk.split('\n')

  check('hunk-lines', shown.length === 2 + 1 + 260_000 + 1, `${shown.length} lines`)
  check('hunk-header', shown[2] === '@@ -1,130000 +1,130000 @@', String(shown[2]))
}

// 3. past the limit: digests, sizes, the first differing path and line
const bigLeft = lines('line ', 200_000)
const bigRight = bigLeft.replace('line 150000\n', 'line changed\n')

check('big-size', bigLeft.length > DIFF_LIMIT, `${bigLeft.length} chars`)

const big = run('big', () => unifiedDiff(bigLeft, bigRight, 'original', 'port', '$.program[3].name'))

if (big !== undefined) {
  const digest = (text: string): string => createHash('sha256').update(text).digest('hex')

  check('big-left-digest', big.includes(`original: 200000 lines, ${bigLeft.length} chars, sha256 ${digest(bigLeft)}`), big)
  check('big-right-digest', big.includes(`sha256 ${digest(bigRight)}`), big)
  check('big-path', big.includes('first differing path: $.program[3].name'), big)
  check('big-line', big.includes('first differing line: 150001\n-line 150000\n+line changed\n'), big)
  check('big-short', big.length < 2_000, `${big.length} chars`)
}

// 4. equal texts
check('equal', unifiedDiff(bigLeft, bigLeft, 'original', 'port') === '', 'not empty')

console.log(`pair-diff: ${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
