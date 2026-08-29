/**
 * The canonical-form conformance vectors: generate them, and check nothing moved.
 *
 * base's 567 tests prove THIS implementation agrees with itself. They prove nothing about a
 * second implementation, and `note/library/base/design/merge-formal-spec.md` warns that
 * without a shared corpus two implementations will disagree. This is that corpus: a
 * language-neutral file of inputs with their canonical bytes and digests, which anyone
 * writing a base implementation in any language can run against.
 *
 * It is also the guard. Content addressing is the base of the whole store, so a digest that
 * moves silently is a migration of everything ever committed, arriving as "the data looks
 * corrupt" months later. Re-hashing the corpus on every build turns that into a failed
 * build with the moved case named.
 *
 * REPORTS BY DEFAULT, WRITES ONLY ON `--commit`. Regenerating is the dangerous direction
 * here, not a read: rewriting the corpus to match a changed encoder is exactly how a
 * hash-breaking change gets waved through, so it takes a deliberate flag and the diff is
 * printed first.
 *
 * Usage:
 *   pnpm check:base-format              # verify every vector, exit non-zero on a moved digest
 *   pnpm check:base-format --write      # show what regenerating WOULD change
 *   pnpm check:base-format --write --commit   # actually rewrite the corpus
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import {
  canonicalBytes,
  bytesToBase16,
} from '@term/base/code/canon/canonicalize'
import { hashRecord } from '@term/base/code/canon/hash'
import { FORMAT_VERSION } from '@term/base/code/canon/format'
import type { RecordNode, Value } from '@term/base/code/base/type'

// Walk up to the folder holding `note/`, so this runs the same from the repo root or from
// any package inside it. Matches how task/checklist/check.ts finds the root.
function findRoot(from: string): string {
  let at = resolve(from)

  while (!existsSync(join(at, 'note', 'workflow'))) {
    const up = dirname(at)

    if (up === at) {
      throw new Error(
        'could not find the repo root (no note/workflow above the working directory)',
      )
    }

    at = up
  }

  return at
}

const ROOT = findRoot(process.cwd())
// Inside the base package, beside the code it pins, so a second implementation cloning the
// package gets the corpus with it rather than having to find it elsewhere in the tree.
const CORPUS = join(
  ROOT,
  'deck/term/deck/term/deck/base/vector/canonical-form.json',
)

const MARK = '0195f0e6-1c4a-7bd3-9f2e-000000000001'

// A vector's fields, in the neutral shape the corpus file publishes: a field name, the base
// value kind, and the value as text. Kept deliberately small so an implementation in another
// language can read it without a base library.
type VectorField = {
  name: string
  kind: string
  value?: string
}

type Vector = {
  name: string
  // what this case pins, so a failure says which RULE broke rather than which digest moved
  asserts: string
  type: string
  field: VectorField[]
}

// The value a neutral field describes. One place builds them, so the corpus and the checker
// cannot disagree about what a vector means.
function valueOf(field: VectorField): Value {
  switch (field.kind) {
    case 'text':
      return { kind: 'text', value: field.value ?? '' }
    case 'integer':
      return { kind: 'integer', value: BigInt(field.value ?? '0') }
    case 'decimal':
      return { kind: 'decimal', value: field.value ?? '0' }
    case 'boolean':
      return { kind: 'boolean', value: field.value === 'true' }
    case 'date':
      return { kind: 'date', value: field.value ?? '' }
    case 'null':
      return { kind: 'null' }
    default:
      throw new Error(`unknown vector field kind: ${field.kind}`)
  }
}

function recordOf(vector: Vector): RecordNode {
  return {
    mark: MARK,
    type: vector.type,
    fields: new Map(vector.field.map(f => [f.name, valueOf(f)])),
  }
}

/**
 * The corpus.
 *
 * Every case names the rule it pins. A second implementation that disagrees on any of these
 * disagrees on the format, not on an implementation detail, which is the whole distinction
 * the corpus exists to make.
 */
const VECTOR: Vector[] = [
  {
    name: 'text_plain',
    asserts: 'a plain text field encodes as DAG-CBOR text',
    type: 'word',
    field: [{ name: 'text', kind: 'text', value: 'hello' }],
  },
  {
    name: 'text_composed',
    asserts:
      'a composed spelling and a decomposed spelling of one string produce identical bytes (NFC)',
    type: 'word',
    field: [{ name: 'text', kind: 'text', value: 'café' }],
  },
  {
    name: 'text_decomposed',
    asserts:
      'the decomposed twin of text_composed. Its digest MUST equal text_composed',
    type: 'word',
    field: [{ name: 'text', kind: 'text', value: 'café' }],
  },
  {
    name: 'field_order_a_then_b',
    asserts: 'field insertion order does not affect the bytes',
    type: 'word',
    field: [
      { name: 'a', kind: 'text', value: '1' },
      { name: 'b', kind: 'text', value: '2' },
    ],
  },
  {
    name: 'field_order_b_then_a',
    asserts:
      'the reversed twin of field_order_a_then_b. Its digest MUST equal it',
    type: 'word',
    field: [
      { name: 'b', kind: 'text', value: '2' },
      { name: 'a', kind: 'text', value: '1' },
    ],
  },
  {
    name: 'key_above_bmp',
    asserts:
      'field names sort by NFC UTF-8 bytes, not UTF-16 code units, so a surrogate pair orders after a three-byte character',
    type: 'word',
    field: [
      { name: '\u{1F600}', kind: 'text', value: 'emoji' },
      { name: '�', kind: 'text', value: 'replacement' },
    ],
  },
  {
    name: 'decimal_trailing_zero',
    asserts: 'a decimal keeps its declared precision, so 1.50 is not 1.5',
    type: 'measure',
    field: [{ name: 'value', kind: 'decimal', value: '1.50' }],
  },
  {
    name: 'decimal_no_trailing_zero',
    asserts:
      'the twin of decimal_trailing_zero. Its digest MUST DIFFER from it',
    type: 'measure',
    field: [{ name: 'value', kind: 'decimal', value: '1.5' }],
  },
  {
    name: 'decimal_beyond_double',
    asserts:
      'a mantissa past 2^53 keeps every digit, so a float-based encoder is caught',
    type: 'measure',
    field: [{ name: 'value', kind: 'decimal', value: '9007199254740993' }],
  },
  {
    name: 'integer_one',
    asserts:
      'an integer is distinguishable from a decimal of equal value (compare with decimal_one)',
    type: 'measure',
    field: [{ name: 'value', kind: 'integer', value: '1' }],
  },
  {
    name: 'decimal_one',
    asserts: 'the decimal twin of integer_one. Its digest MUST DIFFER from it',
    type: 'measure',
    field: [{ name: 'value', kind: 'decimal', value: '1' }],
  },
  {
    name: 'date_tagged',
    asserts:
      'a date carries a tag, so it is distinguishable from text that looks like one (compare with date_as_text)',
    type: 'event',
    field: [{ name: 'when', kind: 'date', value: '2026-08-29' }],
  },
  {
    name: 'date_as_text',
    asserts: 'the text twin of date_tagged. Its digest MUST DIFFER from it',
    type: 'event',
    field: [{ name: 'when', kind: 'text', value: '2026-08-29' }],
  },
  {
    name: 'null_present',
    asserts:
      'an explicit null is distinguishable from a missing field (compare with null_missing)',
    type: 'word',
    field: [
      { name: 'text', kind: 'text', value: 'x' },
      { name: 'note', kind: 'null' },
    ],
  },
  {
    name: 'null_missing',
    asserts:
      'the omitted twin of null_present. Its digest MUST DIFFER from it',
    type: 'word',
    field: [{ name: 'text', kind: 'text', value: 'x' }],
  },
  {
    name: 'boolean_true',
    asserts: 'a boolean encodes as a CBOR simple value, not as text',
    type: 'flag',
    field: [{ name: 'on', kind: 'boolean', value: 'true' }],
  },
]

type Computed = {
  name: string
  asserts: string
  bytes: string
  digest: string
}

function compute(): Computed[] {
  return VECTOR.map(vector => {
    const node = recordOf(vector)

    return {
      name: vector.name,
      asserts: vector.asserts,
      bytes: bytesToBase16(canonicalBytes(node)),
      digest: hashRecord(node),
    }
  })
}

type Corpus = {
  format: string
  mark: string
  note: string
  vector: Array<Vector & Computed>
}

function build(): Corpus {
  const computed = compute()

  return {
    format: FORMAT_VERSION,
    mark: MARK,
    note: 'Canonical-form conformance vectors for base. Every record uses the same mark, so a digest depends only on the rule under test. `bytes` is the canonical DAG-CBOR encoding in base16, `digest` is its sha256. An implementation that reproduces every digest here agrees with base on the canonical form. Generated by task/base/format-check.ts.',
    vector: VECTOR.map((vector, i) => ({ ...vector, ...computed[i]! })),
  }
}

async function main(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .option('write', {
      type: 'boolean',
      default: false,
      describe: 'regenerate the corpus rather than checking it',
    })
    .option('commit', {
      type: 'boolean',
      default: false,
      describe: 'actually write. Without it, --write only reports the diff',
    })
    .strict()
    .parseAsync()

  const built = build()
  const text = `${JSON.stringify(built, null, 2)}\n`

  if (argv.write) {
    if (!existsSync(CORPUS)) {
      console.log(`corpus does not exist yet: ${relative(ROOT, CORPUS)}`)
    } else {
      const before = JSON.parse(readFileSync(CORPUS, 'utf8')) as Corpus
      const moved = built.vector.filter(v => {
        const was = before.vector.find(o => o.name === v.name)

        return was !== undefined && was.digest !== v.digest
      })

      console.log(
        moved.length
          ? `${moved.length} digest(s) WOULD MOVE:\n${moved.map(v => `  ${v.name}: ${v.asserts}`).join('\n')}`
          : 'no digest would move',
      )
    }

    if (!argv.commit) {
      console.log('\nreport only. pass --commit to write.')
      return
    }

    mkdirSync(dirname(CORPUS), { recursive: true })
    writeFileSync(CORPUS, text)
    console.log(`wrote ${built.vector.length} vectors to ${relative(ROOT, CORPUS)}`)
    return
  }

  if (!existsSync(CORPUS)) {
    console.error(
      `no corpus at ${relative(ROOT, CORPUS)}. Generate it with --write --commit`,
    )
    process.exit(1)
  }

  const stored = JSON.parse(readFileSync(CORPUS, 'utf8')) as Corpus
  const problems: string[] = []

  if (stored.format !== built.format) {
    problems.push(
      `corpus was generated under canonical form ${stored.format}, this build writes ${built.format}`,
    )
  }

  for (const vector of built.vector) {
    const was = stored.vector.find(o => o.name === vector.name)

    if (!was) {
      problems.push(`${vector.name} is not in the corpus. Regenerate it`)
      continue
    }

    if (was.digest !== vector.digest) {
      problems.push(
        `${vector.name} MOVED\n    asserts: ${vector.asserts}\n    was:  ${was.digest}\n    now:  ${vector.digest}`,
      )
    }
  }

  for (const was of stored.vector) {
    if (!built.vector.some(v => v.name === was.name)) {
      problems.push(`${was.name} is in the corpus but no longer generated`)
    }
  }

  // The relationships the corpus exists to pin, checked as relationships rather than as
  // digests, so a reader of the output sees the RULE that broke.
  const digestOf = (name: string): string =>
    built.vector.find(v => v.name === name)?.digest ?? ''

  const same: Array<[string, string, string]> = [
    ['text_composed', 'text_decomposed', 'NFC normalization'],
    ['field_order_a_then_b', 'field_order_b_then_a', 'field order independence'],
  ]

  const different: Array<[string, string, string]> = [
    ['decimal_trailing_zero', 'decimal_no_trailing_zero', 'decimal precision'],
    ['integer_one', 'decimal_one', 'integer versus decimal'],
    ['date_tagged', 'date_as_text', 'date tagging'],
    ['null_present', 'null_missing', 'null versus missing'],
  ]

  for (const [a, b, rule] of same) {
    if (digestOf(a) !== digestOf(b)) {
      problems.push(`${rule} BROKE: ${a} and ${b} must hash the same`)
    }
  }

  for (const [a, b, rule] of different) {
    if (digestOf(a) === digestOf(b)) {
      problems.push(`${rule} BROKE: ${a} and ${b} must hash differently`)
    }
  }

  if (problems.length) {
    console.error(
      `\n${problems.length} problem(s):\n\n${problems.map(p => `  ${p}`).join('\n')}\n`,
    )
    console.error(
      'A moved digest is a change to the canonical form. Every commit ever made is\n' +
        'addressed by it, so this is a migration of the whole corpus, not a test to update.\n' +
        'If the change is deliberate, bump the canonical form version and write the\n' +
        'migration. If it is not, revert it.\n',
    )
    process.exit(1)
  }

  console.log(
    `${built.vector.length} vectors, canonical form ${built.format}, every digest holds`,
  )
}

void main()
