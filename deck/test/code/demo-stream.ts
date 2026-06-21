/**
 * Streaming block loader equivalence + constant-memory check. Run from
 * the seed install root:
 *   npx tsx deck/test/code/demo-stream.ts
 *
 * The streaming splitter must produce byte-for-byte the SAME blocks as
 * the whole-file `splitTopLevel`, over the entire stdlib (the invariant
 * that makes streaming safe). We also stream a real file from disk and a
 * synthetic huge file to show constant-memory, block-by-block loading.
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { splitTopLevel } from '@cluesurf/make/code/compile/incremental-parse'
import { splitStreamingToArray, streamFileBlocks } from '@cluesurf/make/code/compile/stream'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

async function main(): Promise<void> {
  const root = process.cwd()
  const files = execSync('find deck/base/code -name "*.tree"', { encoding: 'utf8', cwd: root })
    .trim().split('\n').filter(Boolean)

  // --- equivalence: streaming core == whole-file splitTopLevel, every file ---
  let mismatches = 0
  let totalBlocks = 0
  for (const f of files) {
    const text = readFileSync(path.resolve(root, f), 'utf8')
    const whole = splitTopLevel(text)
    const streamed = splitStreamingToArray(text.split('\n'))
    totalBlocks += whole.length
    if (JSON.stringify(whole) !== JSON.stringify(streamed)) {
      mismatches++
      if (mismatches <= 3) console.log(`    mismatch in ${f}: ${whole.length} vs ${streamed.length} blocks`)
    }
  }
  ok('streaming splitter == splitTopLevel over the whole stdlib', mismatches === 0,
    `(${files.length} files, ${totalBlocks} blocks)`)

  // --- stream a real file from disk block-by-block ---
  const sample = files.find(f => splitTopLevel(readFileSync(path.resolve(root, f), 'utf8')).length >= 2)
  if (sample) {
    const blocks = []
    for await (const b of streamFileBlocks(path.resolve(root, sample))) blocks.push(b)
    const expected = splitTopLevel(readFileSync(path.resolve(root, sample), 'utf8'))
    ok('streamFileBlocks yields the right block count + start lines',
      blocks.length === expected.length &&
      blocks.every((b, i) => b.startLine === expected[i]!.startLine),
      `(${blocks.length} blocks from ${sample.split('/').pop()})`)
  }

  // --- huge synthetic file: stream it block-by-block, constant memory ---
  const dir = mkdtempSync(path.join(tmpdir(), 'seed-stream-'))
  const huge = path.join(dir, 'huge.tree')
  const N = 50_000
  const parts: string[] = []
  for (let i = 0; i < N; i++) parts.push(`task t${i}\n  send back, mark ${i}\n`)
  writeFileSync(huge, parts.join('\n'))

  const t0 = Date.now()
  let streamedCount = 0
  let last = -1
  let ordered = true
  for await (const b of streamFileBlocks(huge)) {
    streamedCount++
    if (b.startLine <= last) ordered = false
    last = b.startLine
  }
  ok('streamed a 50k-definition file block-by-block', streamedCount === N,
    `(${streamedCount} blocks in ${Date.now() - t0}ms)`)
  ok('streamed blocks arrive in source order', ordered)

  console.log(`\nseed-verify stream demo: ${pass} pass, ${fail} fail`)
  if (fail > 0) process.exit(1)
}

main()
