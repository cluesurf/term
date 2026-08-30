// Fixture-driven parser conformance. Each file in ./file is a source, then a `---` line, then the expected
// canonical expanded tree. Ported from the original tree implementation (deck/tree/test/file), which had them
// and this repo did not: test/parser/run.ts only ever carried inline cases, so the ported parser was never held
// to the fixtures the grammar was actually specified by.
//
// ./file/kink holds sources that must be REFUSED, with the expected diagnostic message after the `---`.
//
// Run: npx tsx test/parser/fixture.ts   (FIND=<substr> to run a subset)

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse, printTree } from '@term/make/code/parser/tree'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const DIR = join(HERE, 'file')
const FIND = process.env.FIND

// Fixtures the ORIGINAL tree language passed that Term deliberately does not, with the reason. These are kept
// rather than edited or dropped: they are the record of where the two grammars part company, and a change in
// this list should be a decision, not a surprise. Term narrowed `{...}` to substituting a single NAME (so a
// comma inside one is refused) and `{{...}}` to runtime interpolation, where the original parsed both as
// arbitrary nested trees.
const DIVERGENT = new Map<string, string>([])

let pass = 0
let fail = 0
let divergent = 0
const failures: string[] = []
const diverged: string[] = []

function split(text: string): [string, string] | undefined {
  const parts = text.split(/\n---\n/)

  if (parts.length < 2) {
    return undefined
  }

  return [parts[0]!.trim(), parts.slice(1).join('\n---\n').trim()]
}

function runTree(file: string, source: string, expected: string): void {
  const result = parse({ file, text: source })

  if (!result.ok) {
    fail++
    failures.push(`${file}\n  refused: ${result.diagnostics.map(d => d.message).join('; ')}`)

    return
  }

  const got = printTree(result.tree).trim()

  if (got === expected) {
    pass++

    return
  }

  fail++
  failures.push(`${file}\n--- got ---\n${got}\n--- want ---\n${expected}`)
}

function runKink(file: string, source: string, expected: string): void {
  const result = parse({ file, text: source })

  if (result.ok) {
    fail++
    failures.push(`${file}\n  expected a refusal, but it parsed`)

    return
  }

  const got = result.diagnostics.map(d => d.message).join('\n')

  // the ported messages were written for a different diagnostic system, so a fixture passes when the expected
  // text appears in what this parser says, rather than matching it word for word
  if (got.includes(expected) || expected.includes(got)) {
    pass++

    return
  }

  fail++
  failures.push(`${file}\n--- got ---\n${got}\n--- want ---\n${expected}`)
}

function walk(dir: string, kink: boolean): void {
  if (!existsSync(dir)) {
    return
  }

  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.tree')) {
      continue
    }

    const path = join(dir, entry)
    const label = `${kink ? 'kink/' : ''}${entry}`

    if (FIND && !label.includes(FIND)) {
      continue
    }

    const parts = split(readFileSync(path, 'utf8'))

    if (!parts) {
      fail++
      failures.push(`${label}\n  no \`---\` separator`)
      continue
    }

    const reason = DIVERGENT.get(label)

    if (reason) {
      divergent++
      diverged.push(`${label}  ${reason}`)
      continue
    }

    if (kink) {
      runKink(label, parts[0], parts[1])
    } else {
      runTree(label, parts[0], parts[1])
    }
  }
}

walk(DIR, false)
walk(join(DIR, 'kink'), true)

for (const line of failures) {
  console.log(`FAIL  ${line}\n`)
}

for (const line of diverged) {
  console.log(`note  ${line}`)
}

console.log(`\nparser fixtures: ${pass} pass, ${fail} fail, ${divergent} documented divergence(s) from the original grammar`)

if (fail > 0) {
  process.exit(1)
}
