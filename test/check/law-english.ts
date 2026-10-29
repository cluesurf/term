// A law in words (check/law-english.ts, note/project/term/assurance/prove-loop, item 0001).
// Run: npx tsx test/check/law-english.ts [--census]
//
// What it holds:
//   - TWENTY TARGETS. Twenty rules of deck/base and seed.tree, each with the English written by hand from the rule's
//     Term form before the renderer existed. The renderer, run on the real file through the parser and the mill, must
//     produce each sentence exactly
//   - A WRONG LAW SHOWS. A transitivity law with its conclusion reversed, named as if it were right and commented as
//     if it were right, reads "then c is less than a"
//   - NAME AND COMMENT ARE NOT READ. The same rule under another name and another comment reads the same sentence
// `--census` renders every rule of deck/base and seed.tree and prints rendered, needs-a-word and refused counts, with
// the words most often missing.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { lawSentencesOf } from '@term/make/code/check/law-english'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'

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

const BASE = new URL('../../deck/base/', import.meta.url).pathname
const SEED = new URL('../../../seed.tree/', import.meta.url).pathname

const roleOf = {
  [BASE]: projectRoleOf(BASE),
  [SEED]: projectRoleOf(SEED),
}
const leanOf = {
  [BASE]: projectLeanOf(BASE),
  [SEED]: projectLeanOf(SEED),
}

function lawsOfFile(
  root: string,
  file: string,
): ReturnType<typeof lawSentencesOf> {
  const path = join(root, file)
  return lawSentencesOf({
    file: path,
    text: readFileSync(path, 'utf8'),
    role: roleOf[root]!(path) ?? undefined,
    lean: leanOf[root]!(path),
  })
}

// written by hand from each rule's `.tree` text, not from the renderer's output
const TARGETS: {
  root: string
  file: string
  rule: string
  english: string
}[] = [
  {
    root: BASE,
    file: 'code/proof/equal/refl.tree',
    rule: 'refl',
    english:
      'For every type a and every value x of type a, x equals x.',
  },
  {
    root: BASE,
    file: 'code/proof/equal/symmetry.tree',
    rule: 'symmetry',
    english:
      'For every type a and all values x and y of type a, if x equals y, then y equals x.',
  },
  {
    root: BASE,
    file: 'code/proof/equal/transitivity.tree',
    rule: 'transitivity',
    english:
      'For every type a and all values x, y and z of type a, if x equals y and y equals z, then x equals z.',
  },
  {
    root: BASE,
    file: 'code/proof/equal/congruence.tree',
    rule: 'congruence',
    english:
      'For all types a and b, every function f from a to b and all values x and y of type a, if x equals y, then f of x equals f of y.',
  },
  {
    root: BASE,
    file: 'code/proof/equal/substitution.tree',
    rule: 'substitution',
    english:
      'For every type a, every property p of values of type a and all values x and y of type a, if x equals y and p holds of x, then p holds of y.',
  },
  {
    root: BASE,
    file: 'code/proof/absurd.tree',
    rule: 'absurd',
    english:
      'For every type a, if there is a value of never, the type with no values, then there is a value of type a.',
  },
  {
    root: SEED,
    file: 'code/order/law.tree',
    rule: 'order-is-reflexive',
    english: 'For every number a, a is at most a.',
  },
  {
    root: SEED,
    file: 'code/order/law.tree',
    rule: 'order-is-antisymmetric',
    english:
      'For all numbers a and b, if a is at most b and b is at most a, then a equals b.',
  },
  // `show miss is-below a a`: the mill negates the comparison, so the sentence says what the prover checks
  {
    root: SEED,
    file: 'code/order/law.tree',
    rule: 'strict-order-is-irreflexive',
    english: 'For every number a, a is at least a.',
  },
  {
    root: SEED,
    file: 'code/order/law.tree',
    rule: 'strict-order-is-translation-invariant',
    english:
      'For all numbers a, b and c, if a is less than b, then a plus c is less than b plus c.',
  },
  {
    root: SEED,
    file: 'code/order/law.tree',
    rule: 'strict-order-is-transitive',
    english:
      'For all numbers a, b and c, if a is less than b and b is less than c, then a is less than c.',
  },
  {
    root: SEED,
    file: 'code/type/roll.tree',
    rule: 'length-of-nil-is-zero',
    english: 'The length of nil equals zero.',
  },
  {
    root: SEED,
    file: 'code/type/roll.tree',
    rule: 'append-nil-left-is-identity',
    english: 'For every roll ys, nil followed by ys equals ys.',
  },
  {
    root: SEED,
    file: 'code/type/roll.tree',
    rule: 'append-is-associative',
    english:
      'For all rolls xs, ys and zs, (xs followed by ys) followed by zs equals xs followed by (ys followed by zs).',
  },
  {
    root: SEED,
    file: 'code/type/roll.tree',
    rule: 'length-of-append-adds',
    english:
      'For all rolls xs and ys, the length of (xs followed by ys) equals (the length of xs) plus (the length of ys).',
  },
  {
    root: SEED,
    file: 'code/type/roll.tree',
    rule: 'reverse-reverse-is-identity',
    english:
      'For every roll xs, the reverse of the reverse of xs equals xs.',
  },
  {
    root: SEED,
    file: 'code/type/roll.tree',
    rule: 'length-of-cons-steps',
    english:
      'For every natural h and every roll t, the length of (cons with item h and more t) equals succ with prior (the length of t).',
  },
  // first written without the parentheses, which reads two ways ("both a and (b equals ...)"). The renderer's grouping
  // rule was right and the hand-written target was corrected to it, the one target changed after the renderer ran
  {
    root: SEED,
    file: 'code/logic/boolean.tree',
    rule: 'both-commutes',
    english:
      'For all flags a and b, (both a and b) equals (both b and a).',
  },
  {
    root: SEED,
    file: 'code/function/property.tree',
    rule: 'compose-associates',
    english:
      'For all types a, b, c and d, every function h from c to d, every function g from b to c, every function f from a to b and every value x of type a, (h after (g after f)) applied to x equals ((h after g) after f) applied to x.',
  },
  {
    root: SEED,
    file: 'code/function/property.tree',
    rule: 'left-inverse-gives-injective',
    english:
      'For all types a and b, every function f from a to b, every function g from b to a and all values x and y of type a, if for every value u of type a, g of f of u equals u, and f of x equals f of y, then x equals y.',
  },
]

const cache = new Map<string, ReturnType<typeof lawsOfFile>>()

for (const target of TARGETS) {
  const key = target.root + target.file

  if (!cache.has(key)) {
    cache.set(key, lawsOfFile(target.root, target.file))
  }

  const read = cache.get(key)!
  const law = read.ok
    ? read.laws.find(l => l.name === target.rule)
    : undefined

  ok(
    `target ${target.rule}`,
    law?.text === target.english,
    `\n      want: ${target.english}\n      got:  ${law?.text ?? law?.refused ?? (read.ok ? 'no such rule' : read.error)}`,
  )
}

// A WRONG LAW. Its name and its comment both say transitivity, and its conclusion is reversed. A person who reads only
// the name approves it, and the sentence shows what it states
const WRONG = `# Transitivity of the strict order: if a is below b and b is below c, then a is below c.
rule strict-order-is-transitive
  seat a, like integer
  seat b, like integer
  seat c, like integer
  have h1
    call is-below
      read a
      read b
  have h2
    call is-below
      read b
      read c
  show hold
    call is-below
      read c
      read a
`

const wrong = lawSentencesOf({ file: 'wrong.tree', text: WRONG })
const wrongText = wrong.ok ? wrong.laws[0]?.text : wrong.error

ok(
  'a wrong law reads wrong',
  wrongText ===
    'For all numbers a, b and c, if a is less than b and b is less than c, then c is less than a.',
  String(wrongText),
)

// the same rule renamed and recommented: the sentence cannot depend on either
const renamed = WRONG.replace(
  'strict-order-is-transitive',
  'c-wins',
).replace(/^# .*$/m, '# anything at all, even a false description')
const renamedRead = lawSentencesOf({
  file: 'renamed.tree',
  text: renamed,
})
ok(
  'the name and the comment are not read',
  renamedRead.ok && renamedRead.laws[0]?.text === wrongText,
  JSON.stringify(renamedRead),
)

// ---- the census ----

function treeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (
      entry === 'node_modules' ||
      entry === 'tmp' ||
      entry === 'host' ||
      entry.startsWith('.')
    ) {
      continue
    }

    const path = join(dir, entry)

    if (statSync(path).isDirectory()) {
      treeFiles(path, out)
    } else if (entry.endsWith('.tree')) {
      out.push(path)
    }
  }

  return out
}

if (process.argv.includes('--census')) {
  // the library and its tests apart: seed.tree's test/case holds controls, laws that are wrong on purpose
  const sections: [string, string][] = [
    [BASE, 'code'],
    [BASE, 'test'],
    [SEED, 'code'],
    [SEED, 'test'],
  ]

  for (const [root, sub] of sections) {
    let rendered = 0
    let needsWord = 0
    let refused = 0
    let filesFailed = 0
    const kinds = new Map<string, number>()
    const missing = new Map<string, number>()
    const reasons = new Map<string, number>()
    const unmilled: string[] = []
    let unreached = 0

    for (const path of treeFiles(join(root, sub))) {
      // every file is read, and one with no rule adds nothing. A file the mill throws on is counted as not milled
      let read: ReturnType<typeof lawSentencesOf>

      try {
        read = lawsOfFile(root, path.slice(root.length))
      } catch (error) {
        // how many rules it holds is unknown: -1 says so
        read = {
          ok: false,
          error: `threw: ${String(error)}`,
          rules: -1,
        }
      }

      if (!read.ok) {
        if (read.rules !== 0) {
          filesFailed++
          unreached += Math.max(0, read.rules)
          unmilled.push(
            `  file not milled (${read.rules} rules): ${path.slice(root.length)}: ${read.error.slice(0, 120)}`,
          )
        }
        continue
      }

      for (const law of read.laws) {
        kinds.set(law.kind, (kinds.get(law.kind) ?? 0) + 1)

        if (law.refused) {
          refused++
          reasons.set(law.refused, (reasons.get(law.refused) ?? 0) + 1)
        } else if (law.words.length > 0) {
          needsWord++
          law.words.forEach(word =>
            missing.set(word, (missing.get(word) ?? 0) + 1),
          )
        } else {
          rendered++
        }
      }
    }

    const top = [...missing.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
    console.log(`\ncensus ${root}${sub}/`)
    console.log(
      `  rules ${rendered + needsWord + refused} (${[...kinds.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}), files with rules not milled ${filesFailed} (${unreached} rules unread)`,
    )
    console.log(
      `  rendered ${rendered}, needs a word ${needsWord}, refused ${refused}`,
    )
    console.log(
      `  distinct missing words ${missing.size}, most used: ${top.map(([w, n]) => `${w} ${n}`).join(', ')}`,
    )
    console.log(
      `  refusals: ${[...reasons.entries()].map(([r, n]) => `${n} ${r}`).join('; ') || 'none'}`,
    )
    unmilled.forEach(line => console.log(line))
  }
}

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
