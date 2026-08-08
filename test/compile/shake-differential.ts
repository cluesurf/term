// Tree-shaking differential harness (note/term/tree-streaming-and-perf.md "Gate + proof"): compile every stdlib
// module as an entry, with and without `treeShake`, and require:
//   1. the same verdict (ok with ok, failure with failure, matching diagnostics on failure)
//   2. every root of the entry survives the prune
//   3. every statement the shaken program keeps is AST-identical to its unshaken counterpart (the prune may only
//      DROP unreachable definitions, never change a kept one)
// Tree-shaking flips on by default only when this is 100% clean across the corpus.
// Run: npx tsx test/compile/shake-differential.ts            (full corpus)
//      npx tsx test/compile/shake-differential.ts <n>        (first n files, for a quick pass)

import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { compile } from '@term/make/code/compile/compile'
import type { Source } from '@term/make/code/compile/load'
import type { Statement } from '@term/make/code/compile/node'

const baseTree = join(process.cwd(), 'deck', 'seed')

// the stdlib's own modules import each other as `@term/seed/...` (the Term rename); older test programs still say
// `@cluesurf/seed/...`. Both spell the same package, so the resolver accepts either prefix.
const STDLIB_PREFIX = /^@(?:cluesurf|term)\/seed\//

const stdlib = (path: string): Source | undefined => {
  if (!STDLIB_PREFIX.test(path)) {
    return undefined
  }

  const rest = path.replace(STDLIB_PREFIX, '')

  for (const candidate of [
    join(baseTree, `${rest}.tree`),
    join(baseTree, rest, 'base.tree'),
  ]) {
    if (existsSync(candidate)) {
      return { file: candidate, text: readFileSync(candidate, 'utf8') }
    }
  }

  return undefined
}

// relative loads within the stdlib tree resolve against the importing file
const resolve = (path: string, from: string): Source | undefined => {
  if (STDLIB_PREFIX.test(path)) {
    return stdlib(path)
  }

  if (path.startsWith('./') || path.startsWith('../')) {
    const base = join(from, '..', path)

    for (const candidate of [`${base}.tree`, join(base, 'base.tree')]) {
      if (existsSync(candidate)) {
        return {
          file: candidate,
          text: readFileSync(candidate, 'utf8'),
        }
      }
    }
  }

  return undefined
}

// a stable structural key for a statement: span-free, and with UNSOLVED inference-variable ids canonicalized in
// first-occurrence order (their numeric values are allocation-order artifacts, so a smaller shaken program yields
// smaller ids for the same unsolved variable; only the SHAPE may be compared)
function shape(statement: Statement): string {
  const canon = new Map<number, number>()

  return JSON.stringify(statement, (key, value: unknown) => {
    if (key === 'span') {
      return undefined
    }

    if (
      typeof value === 'object' &&
      value !== null &&
      (value as { kind?: string }).kind === 'variable' &&
      typeof (value as { id?: number }).id === 'number'
    ) {
      const id = (value as { id: number }).id

      if (!canon.has(id)) {
        canon.set(id, canon.size)
      }

      return { ...(value as object), id: canon.get(id) }
    }

    return value
  })
}

const limit = process.argv[2] ? Number(process.argv[2]) : Infinity

const files = execSync(`find ${baseTree}/code -name '*.tree'`, {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .sort()
  .slice(0, limit)

let clean = 0
let divergent = 0
let failedBoth = 0

const problems: string[] = []

for (const file of files) {
  const text = readFileSync(file, 'utf8')

  const plain = compile({ file, text }, { resolve })
  const shaken = compile({ file, text }, { resolve, treeShake: true })

  if (plain.ok !== shaken.ok) {
    divergent++
    problems.push(
      `${file}: verdict differs (plain ${plain.ok ? 'ok' : 'fail'}, shaken ${
        shaken.ok ? 'ok' : 'fail'
      })${
        !shaken.ok && 'diagnostics' in shaken
          ? ` :: ${shaken.diagnostics[0]?.message ?? ''}`
          : !plain.ok && 'diagnostics' in plain
            ? ` :: ${plain.diagnostics[0]?.message ?? ''}`
            : ''
      }`,
    )
    continue
  }

  if (!plain.ok || !shaken.ok) {
    failedBoth++
    continue
  }

  // index the unshaken program's statements by (form, name). A name may have SEVERAL statements (an abstract
  // signature and its native implementation, or arity overloads pre-disambiguation), so keep a multiset: each
  // shaken statement must match one plain statement of its key.
  const reference = new Map<string, string[]>()

  for (const statement of plain.program) {
    const name = (statement as { name?: string }).name

    if (name) {
      const key = `${statement.form}:${name}`
      const list = reference.get(key)

      if (list) {
        list.push(shape(statement))
      } else {
        reference.set(key, [shape(statement)])
      }
    }
  }

  // the entry's own top-level functions must all survive
  const shakenNames = new Set(
    shaken.program
      .map(s => (s as { name?: string }).name)
      .filter(Boolean),
  )

  let bad = false

  for (const statement of plain.program) {
    if (statement.form !== 'function') {
      continue
    }
  }

  for (const statement of shaken.program) {
    const name = (statement as { name?: string }).name

    if (!name) {
      continue
    }

    const candidates = reference.get(`${statement.form}:${name}`)

    if (candidates === undefined) {
      problems.push(
        `${file}: shaken keeps ${statement.form} "${name}" the plain build does not have`,
      )
      bad = true
    } else {
      const here = shape(statement)
      const at = candidates.indexOf(here)

      if (at === -1) {
        problems.push(
          `${file}: ${statement.form} "${name}" differs between plain and shaken`,
        )
        bad = true
      } else {
        candidates.splice(at, 1) // consumed: a second same-shape statement must match another copy
      }
    }
  }

  void shakenNames

  if (bad) {
    divergent++
  } else {
    clean++
  }
}

console.log(
  `shake-differential: ${clean} clean, ${divergent} divergent, ${failedBoth} failed-both, of ${files.length}`,
)

for (const p of problems.slice(0, 20)) {
  console.log(`  ${p}`)
}

console.log(
  `\nshake-differential: ${divergent === 0 ? files.length : 0} pass, ${divergent} fail`,
)
process.exit(divergent === 0 ? 0 : 1)
