// Every HEAD a mill grammar anchors is a four-letter word from hold/base/terms.json. That list is the vocabulary
// Term is written in; a head outside it is a word somebody reached for without checking, and it then lives in every
// file that uses the construct. Run: npx tsx test/compile/head-words.ts
//
// A HEAD is a word that can START A LINE. A rule's lines are read by its `mine list` sites, so a rule named as an
// alternative inside some `mine list` (directly, or inside that list's `mine any`) is a LINE RULE, and the word it is
// anchored on (its first `mine term, term <word>`, or each alternative's in a leading `mine any`) is a head. A word
// anchored anywhere else sits inside a line: a leaf in second position (`note unsafe`, `base true`), a combinator
// after `like` (`and`, `or`), or the mill's own meta-grammar (`any`, `maybe`), none of which is a head. The six
// literals can stand alone on a line as a value, and are values rather than heads, so they are not held either.
//
// The grammars are read with the compiler's own parser through deck/deck/code/read.ts. There is one parser for
// `.tree` (note/term/one-parser.md), and a regex over `term <word>` cannot tell a head from a leaf.
//
// KNOWN holds the heads outside the list on the day this gate went up (2026-10-02), each with its replacement
// still to be decided. It may only shrink: a new head outside the list fails, and a KNOWN head that is gone fails too,
// so the list cannot keep a name that no longer needs it. proof-by-default-0020.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
// relative, because @term/deck is a published package with no path alias in this repo
import { readTree } from '../../deck/deck/code/read'
import type { Form } from '../../deck/deck/code/read'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const MILL = join(TERM, 'deck/mill/code')
const TERMS = join(TERM, '../../../../hold/base/terms.json')

// heads outside terms.json, with where each lives. Renaming one is a mechanical rewrite checked mill-equivalent.
const KNOWN = new Set<string>([
  // code: `send back` is in nearly every task, so its rename is a migration of its own
  'send',
  // code: `free x`, an ownership hint, which `move` already covers
  'free',
  // code: `fall`, a parameter default and a fork arm
  'fall',
  // code: `tag <name>` on a declaration. Three letters, and `note` already carries metadata
  'tag',
  // code: the bare fork arms (code/fork/mine.tree fork-arm-bare); `miss` is the else arm already
  'else',
  'step',
  // code: a type's alternatives and conjunction under `like` (code/like/mine.tree)
  'or',
  'and',
  // code: a form's computed accessor (code/form/mine.tree form-accessor)
  'accessor',
  // bind: words the binding dialect carries and the compiler passes over (code/drop/mine.tree)
  'computed',
  'intrinsic',
  'force',
  // note: inline bold in the document dialect (note/surf/mine.tree)
  'bold',
  // deck/lock: the signer's public key of an `oci://` package (deck/lock/mine.tree lock-key), written and read by
  // deck/deck/code/lock.ts. It arrived after the gate went up (2026-10-02, 7b97bc88), and terms.json holds no word for
  // a signing key, so renaming it is a lock-format change for whoever owns that format, not a mechanical rewrite
  'key',
  // operand: the byte-layout dialect's own heads (operand/mine.tree)
  'shift',
  'slate',
  'start',
  'state',
  'write',
])

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

function walk(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)

    if (statSync(path).isDirectory()) {
      walk(path, into)
    } else if (name === 'mine.tree') {
      into.push(path)
    }
  }

  return into
}

// the word a `mine term, term <word>` form anchors, or undefined
function anchored(form: Form): string | undefined {
  if (form.head !== 'mine' || form.terms[0] !== 'term') {
    return undefined
  }

  const term = form.forms.find(f => f.head === 'term')

  return term?.terms[0]
}

// the heads a top-level rule anchors
function headsOf(rule: Form): string[] {
  const first = rule.forms.find(f => f.head === 'mine')

  if (!first) {
    return []
  }

  const word = anchored(first)

  if (word !== undefined) {
    return [word]
  }

  // `mine any` of alternatives, each anchored on its own head (the proof steps, for one)
  if (first.terms[0] === 'any') {
    return first.forms
      .map(anchored)
      .filter((w): w is string => w !== undefined)
  }

  return []
}

// the literals a line may hold as a bare value
const LITERALS = new Set(['true', 'false', 'void'])

// the rules named as alternatives of a `mine list`, anywhere under a form: `mine form, like <rule>` directly in the
// list, or inside the list's own `mine any`
function lineRules(form: Form, into: Set<string>): void {
  const named = (alternative: Form): void => {
    if (alternative.head === 'mine' && alternative.terms[0] === 'form') {
      const like = alternative.forms.find(f => f.head === 'like')

      if (like?.terms[0]) {
        into.add(like.terms[0])
      }
    }

    if (alternative.head === 'mine' && alternative.terms[0] === 'any') {
      alternative.forms.forEach(named)
    }
  }

  if (form.head === 'mine' && form.terms[0] === 'list') {
    form.forms.forEach(named)
  }

  form.forms.forEach(child => lineRules(child, into))
}

function main(): void {
  const allowed = new Set<string>(
    JSON.parse(readFileSync(TERMS, 'utf8')) as string[],
  )
  const outside = new Map<string, string[]>()
  const rulesByName = new Map<string, { rule: Form; file: string }[]>()
  const lines = new Set<string>()
  let rules = 0
  let unreadable = 0

  for (const file of walk(MILL)) {
    const read = readTree({ file, text: readFileSync(file, 'utf8') })

    if (!('forms' in read) || !Array.isArray(read.forms)) {
      unreadable++
      continue
    }

    for (const rule of read.forms as Form[]) {
      if (rule.head !== 'mine' || rule.terms.length !== 1) {
        continue
      }

      rules++
      const list = rulesByName.get(rule.terms[0]!) ?? []
      list.push({ rule, file })
      rulesByName.set(rule.terms[0]!, list)
      lineRules(rule, lines)
    }
  }

  for (const name of lines) {
    for (const { rule, file } of rulesByName.get(name) ?? []) {
      for (const head of headsOf(rule)) {
        if (!allowed.has(head) && !LITERALS.has(head)) {
          const where = outside.get(head) ?? []
          where.push(`${relative(MILL, file)} (${name})`)
          outside.set(head, where)
        }
      }
    }
  }

  console.log(`  ${lines.size} line rules among ${rules}`)

  console.log(`  ${rules} rules read, ${unreadable} file(s) unreadable`)

  ok('every grammar file reads with the compiler parser', unreadable === 0)
  ok('the gate found rules to check', rules > 100, `${rules}`)

  const fresh = [...outside.keys()].filter(h => !KNOWN.has(h)).sort()
  ok(
    'no head outside hold/base/terms.json beyond the known list',
    fresh.length === 0,
    fresh.map(h => `${h}: ${outside.get(h)!.join(', ')}`).join(' | '),
  )

  const gone = [...KNOWN].filter(h => !outside.has(h)).sort()
  ok(
    'every known exception is still needed (the list only shrinks)',
    gone.length === 0,
    `no longer a head, remove from KNOWN: ${gone.join(', ')}`,
  )

  console.log(`\nhead-words: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exitCode = 1
  }
}

main()
