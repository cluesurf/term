// The mint-bridge gate. Two questions, both answered as shrinking numbers.
//
// 1. GRAMMAR. Does the mint half say what the mine half found? A mine rule fills SITES; its mint reads sites by
//    name. A site the mint never reads is content dropped on the floor, silently, which is the whole failure
//    class this project exists to end. Also: no rule name defined twice (the merge is concatenation, so the
//    last definition wins and the earlier ones vanish), and no rule referenced that is not reachable.
//
// 2. PROGRAMS. Does the grammar build one, for every non-draft `.tree` file in every package? A file the bridge
//    refuses is a construct the language has and the grammar does not.
//
// 3. HISTORY, under `--reference` only. Does the grammar build the same `Program` the retired hand-written
//    reader did, compared as canonical JSON with spans included? That comparison is what drove the switch
//    (mint-bridge-0004) and it is kept so the 70 written-down normalizations can be re-read. It loads
//    `compile/mill-legacy.ts`, the ONLY thing that still does, so the default run works after that file goes.
//
// Run from the repository root: `pnpm term:mint-parity`. Reports by default and writes nothing.
// Design: note/project/term/mill/review/mint-bridge/readme.md. Ledgers: normalizations.md, quirks.md.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import { expandTemplates } from '@term/make/code/compile/template'
import { loadRoleGrammar } from '@term/make/code/compile/mill-load'
import { projectRoleOf, projectLeanOf } from '@term/call/code/role-of'
import { buildable } from '@term/call/code/make'
import {
  runMine,
  runMint,
  readLeanRules,
} from '@term/make/code/compile/mill-run'
import type {
  MineRule,
  MintGrammar,
  MineGrammar,
} from '@term/make/code/compile/mill-run'
import { millByGrammar } from '@term/make/code/compile/mint-bridge'
import {
  canonical,
  diffCanonical,
  censusProgram,
} from '@term/make/code/compile/program-json'
import {
  bakedMineText,
  bakedMintText,
  bakedReadText,
} from '@term/make/code/compile/mill-grammar'
import { grammarReadText } from '@term/make/code/compile/mill-grammar-text'
import { TERM_ROOT } from './root'

// Every alternative that an earlier GREEDY one makes unreachable.
//
// A rule is greedy when its first matcher takes any head word there is: a bare `mine term`, a `mine word`, a
// `mine open`, or an alternation or reference that reaches one. The value rule `seed` ends in exactly that, so
// an alternative listed after `seed` in any `mine any` is dead, and the symptom is never a parse error: the
// construct is read as a call to its own head word and the difference surfaces somewhere else entirely. It cost
// a `host` in a task body, a `fork test, name all`, a `move`, a `lace`, a `cast`, a `tune` and a `view`, each
// found one at a time before this was written.
//
// `seed-call-open` before `word` is the one benign pair and is not reported: an open call needs at least one
// argument and a word needs none, so neither can take the other's input.
function shadowedAlternatives(mine: MineGrammar): string[] {
  type Rule = {
    kind: string
    word?: string
    like?: string
    children?: Rule[]
  }

  const greedy = new Set<string>()
  let grew = true

  const reaches = (rule: Rule): boolean => {
    switch (rule.kind) {
      case 'term':
        return rule.word === undefined
      case 'word':
      case 'open':
        return true
      case 'form':
        return greedy.has(rule.like ?? '')
      case 'any':
      case 'maybe':
        return (rule.children ?? []).some(reaches)
      default:
        return false
    }
  }

  while (grew) {
    grew = false

    for (const [name, rules] of mine) {
      const first = (rules as Rule[])[0]

      if (!greedy.has(name) && first && reaches(first)) {
        greedy.add(name)
        grew = true
      }
    }
  }

  // an open call cannot match a childless group, so it does not shadow the bare-word alternative
  const benign = (before: Rule, after: Rule): boolean =>
    before.kind === 'form' &&
    before.like === 'seed-call-open' &&
    after.kind === 'word'

  const found: string[] = []

  // A SEQUENCE has the same hazard as an alternation. `mine walk` matched its sequence before its `hook` arms,
  // and the greedy value maybe took the first arm as the sequence, so every `walk test` loop came out with a
  // constant `true` for its condition. A greedy `maybe` or `list` step followed by another optional step is
  // the shape, and it is reported wherever the later step is not the same rule (matching the arms twice, before
  // and after, is the fix, so that pattern is not a finding).
  const sequence = (name: string, steps: Rule[]): void => {
    steps.forEach((step, at) => {
      if (step.kind !== 'maybe' && step.kind !== 'list') {
        return
      }

      const inner = (step.children ?? [])[0]

      if (!inner || inner.kind !== 'form' || !greedy.has(inner.like ?? '')) {
        return
      }

      // What a step can match, by rule name. A step whose rules were ALREADY tried before the greedy one is
      // the deliberate fix for this hazard rather than an instance of it: `mine walk` matches its arms, then
      // the sequence, then its arms again, because an arm is always headed `hook` and a sequence never is.
      const covers = (step: Rule): string[] => {
        const names: string[] = []
        const collect = (rule: Rule): void => {
          if (rule.kind === 'form' && rule.like) {
            names.push(rule.like)
          }

          if (rule.kind === 'node') {
            names.push('(node)')
          }

          for (const kid of rule.children ?? []) {
            collect(kid)
          }
        }
        collect(step)

        return names
      }

      const tried = new Set(steps.slice(0, at).flatMap(covers))
      const later = steps
        .slice(at + 1)
        .filter(next => {
          if (next.kind !== 'maybe' && next.kind !== 'list') {
            return false
          }

          const rules = covers(next)

          // a trailing `mine node` skip takes whatever is left on purpose, and nothing is written after it
          return (
            rules.length > 0 &&
            !rules.every(rule => rule === '(node)' || tried.has(rule))
          )
        })

      if (later.length > 0) {
        found.push(
          `${name}: the \`${inner.like}\` step takes any head word, so the steps after it never get their turn: ${later
            .map(k => covers(k).join('/') || k.kind)
            .join(', ')}`,
        )
      }
    })
  }

  const walk = (name: string, rule: Rule): void => {
    sequence(name, rule.children ?? [])

    if (rule.kind === 'any') {
      const kids = rule.children ?? []

      kids.forEach((kid, at) => {
        const dead = kids
          .slice(at + 1)
          .filter(later => !benign(kid, later))

        if (
          dead.length > 0 &&
          kid.kind === 'form' &&
          greedy.has(kid.like ?? '')
        ) {
          found.push(
            `${name}: \`${kid.like}\` takes any head word, so nothing after it is reachable: ${dead
              .map(k => (k.kind === 'form' ? k.like : k.kind))
              .join(', ')}`,
          )
        }
      })
    }

    for (const kid of rule.children ?? []) {
      walk(name, kid)
    }
  }

  for (const [name, rules] of mine) {
    sequence(name, rules as Rule[])

    for (const rule of rules as Rule[]) {
      walk(name, rule)
    }
  }

  return found
}

// run from the Term root, the way every other term gate is (the `@term/*` path aliases resolve there)
const TERM = TERM_ROOT
const MILL = join(TERM, 'deck/mill/code/tree')
const DECK = join(TERM, 'deck')

// Every package's `.tree` code, not just the stdlib. The stdlib is the biggest pool but it is not the widest:
// `deck/site` writes `hook </path>` routes, `deck/face` writes views, `deck/zone` writes its own dialect. A
// reader proven on one package is a reader proven on one package.
//
// READ FROM THE DIRECTORY, never a written list. This used to be twelve names typed out, and the three it did
// not name were `bind`, `feed` and `mill`. `bind` alone is 3,091 files, more than the whole rest of the pool,
// and it is where the platform bindings live, so it exercises `name <NativeName>`, `lock`, `base` and variadics
// that nothing else in the tree writes. The gate read 884 files, called that everything, and the switch it
// cleared failed. A list of packages is a guess about what exists; the directory is the answer.
function packagesUnder(deck: string): string[] {
  return readdirSync(deck, { withFileTypes: true })
    .filter(e => e.isDirectory() && existsSync(join(deck, e.name, 'code')))
    .map(e => e.name)
    .sort()
}

// Named skips: files whose `compile/mill.ts` Program is not a meaningful target to reproduce. Each one gets a
// reason, the way the native gate names its platform gaps, so a skip can never quietly become a hiding place.
const NAMED_SKIP: Record<string, string> = {
  'seed/code/proof/absurd.tree': 'the kernel proof island',
  'seed/code/proof/equal/refl.tree': 'the kernel proof island',
  'seed/code/proof/equal/symmetry.tree': 'the kernel proof island',
  'seed/code/proof/equal/transitivity.tree': 'the kernel proof island',
  'seed/code/proof/equal/substitution.tree': 'the kernel proof island',
  'seed/code/proof/equal/congruence.tree': 'the kernel proof island',
}

// A `code/proof/` module is a `rule` (a theorem) and a `test` (its proof term). `mill.ts` has no lowering for
// either: the rule becomes a function with no parameters returning unit, discarding its quantified marks and
// its claim, and the proof term falls into the generic "an unknown head is a call" path and becomes a nested
// call to functions that do not exist. Neither is a program. Reproducing them would write that nonsense into
// the bridge and call it a specification. The kernel reads these files through `check/elaborate.ts`; what the
// mill makes of them is not what runs. Recorded as quirk 5 in note/project/term/mill/review/mint-bridge/quirks.md.

// The STYLE dialect. A file with a top-level `face` or `tone` head is written in the look / CSS dialect, which
// the code role does not read: `mill.ts` mills it through its generic "an unknown head is a call" path, so what
// it produces is not a program either, which is quirk 5's family.
//
// `view` came OFF this list on 2026-08-31. It is the component head in the code role, `view-rename` is done, and
// the component is a real grammar now (deck/mill/code/tree/code/view/) with a real bridge, so those files are
// measured rather than skipped. Skipping them hid 639 disagreements, more than a quarter of everything left.
const STYLE_DIALECT = /^(face|tone)\b/m

function inViewDialect(text: string): boolean {
  return STYLE_DIALECT.test(text)
}

const only = process.argv.find(a => a.startsWith('--only='))?.slice(7)
const limit = Number(
  process.argv.find(a => a.startsWith('--limit='))?.slice(8) ?? '8',
)
const verbose = process.argv.includes('--verbose')
// the retired hand-written reader, by its own name: `compile/mill.ts` points at the grammar path now, and a
// gate that compares a thing to itself proves nothing. Loaded on demand so the default run does not import it.
const REFERENCE = process.argv.includes('--reference')

async function handMill(): Promise<
  typeof import('@term/make/code/compile/mill-legacy').millByHand | undefined
> {
  if (!REFERENCE) {
    return undefined
  }

  const legacy = await import('@term/make/code/compile/mill-legacy')

  return legacy.millByHand
}

// ---- the grammar half ----

// every site a mine rule fills, not descending into the rules it references (those are their own rules)
function sitesOf(rules: MineRule[], into = new Set<string>()): Set<string> {
  for (const rule of rules) {
    if ('site' in rule && rule.site) {
      into.add(rule.site)
    }

    if ('children' in rule && rule.children.length > 0) {
      sitesOf(rule.children, into)
    }
  }

  return into
}

// the rules a mine rule references by name, so reachability can be checked against the mint side
function referencesOf(
  rules: MineRule[],
  into = new Set<string>(),
): Set<string> {
  for (const rule of rules) {
    if (rule.kind === 'form') {
      into.add(rule.like)
    }

    if ('children' in rule && rule.children.length > 0) {
      referencesOf(rule.children, into)
    }
  }

  return into
}

type GrammarReport = {
  mineRules: number
  mintRules: number
  collisions: number
  missingMints: string[]
  danglingMints: string[]
  unreadSites: { rule: string; sites: string[] }[]
  deadCases: { rule: string; cases: string[] }[]
}

function checkGrammar(
  mine: MineGrammar,
  mint: MintGrammar,
  collisions: number,
): GrammarReport {
  const missingMints: string[] = []
  const unreadSites: GrammarReport['unreadSites'] = []
  const deadCases: GrammarReport['deadCases'] = []

  for (const [name, rules] of mine) {
    const sites = sitesOf(rules)
    const built = mint.get(name)

    if (!built) {
      // a mine rule with no mint of its own name is only a problem when something would fall back to it:
      // `runMint` uses the mine rule's name when a `case` does not name its mint. Report them all; the ones a
      // case names explicitly show up as reachable anyway.
      if (sites.size > 0) {
        missingMints.push(name)
      }

      continue
    }

    const read = new Set(built.cases.map(c => c.site ?? c.name))
    const unread = [...sites].filter(s => !read.has(s)).sort()
    const dead = [...read].filter(s => !sites.has(s)).sort()

    if (unread.length > 0) {
      unreadSites.push({ rule: name, sites: unread })
    }

    if (dead.length > 0) {
      deadCases.push({ rule: name, cases: dead })
    }
  }

  // a mint a case names that no reachable mint defines
  const dangling = new Set<string>()

  for (const built of mint.values()) {
    for (const c of built.cases) {
      if (c.mint && !mint.has(c.mint)) {
        dangling.add(c.mint)
      }
    }
  }

  // a mine rule referenced anywhere, whose mint is not reachable and would be reached by the name fallback
  for (const rules of mine.values()) {
    for (const name of referencesOf(rules)) {
      if (!mint.has(name) && mine.has(name)) {
        dangling.add(name)
      }
    }
  }

  return {
    mineRules: mine.size,
    mintRules: mint.size,
    collisions,
    missingMints: missingMints.sort(),
    danglingMints: [...dangling].sort(),
    unreadSites: unreadSites.sort((a, b) => b.sites.length - a.sites.length),
    deadCases: deadCases.sort((a, b) => b.cases.length - a.cases.length),
  }
}

// ---- the parity half ----

// The build walk's own rule: a `draft.tree` in a directory shelves that directory and everything under it, and
// a `mark draft` line (or the old `note draft`) shelves one file. A shelved module is not in the build, so it is not something the reader
// is asked to agree about either. The per-file marker was honoured here from the start and the DIRECTORY one was
// not, which is how three half-written `lace` files in `deck/mill/code/text/html/` (shelved by their own
// `draft.tree` since before this gate existed) were counted against the grammar as unbuilt constructs.
// See `findTreeFiles` in deck/call/code/make.ts.
function walk(dir: string, into: string[] = []): string[] {
  if (existsSync(join(dir, 'draft.tree'))) {
    return into
  }

  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)

    if (statSync(path).isDirectory()) {
      walk(path, into)
    } else if (name.endsWith('.tree')) {
      into.push(path)
    }
  }

  return into
}

async function main(): Promise<void> {
  const millByHand = await handMill()
  const grammar = loadRoleGrammar(MILL, 'code')

  for (const problem of grammar.problems) {
    console.log(`  grammar problem: ${problem}`)
  }

  // the baked copy the compiler reads must match the grammar on disk, or the compiler is milling with a
  // different language than the one in the files
  // compile/mill-grammar.tree, generated by pnpm term:mill-bundle
  const mineSource = bakedMineText()
  const mintSource = bakedMintText()
  const bakedMine = parse({ file: 'baked-mine.tree', text: mineSource })
  const bakedMint = parse({ file: 'baked-mint.tree', text: mintSource })
  const bakedFresh =
    mineSource === grammar.mineText &&
    mintSource === grammar.mintText &&
    bakedReadText() === grammarReadText(grammar.mineText, grammar.mintText)

  console.log(
    `  baked grammar (pnpm term:mill-bundle): ${bakedFresh ? 'current' : 'STALE, re-run it'}`,
  )

  if (!bakedMine.ok || !bakedMint.ok) {
    console.log('  the baked grammar does not parse')
  }

  const report = checkGrammar(
    grammar.mine,
    grammar.mint,
    grammar.collisions.length,
  )

  console.log('mint-parity: grammar')
  console.log(
    `  rules: ${report.mineRules} mine, ${report.mintRules} mint`,
  )
  console.log(`  name collisions: ${report.collisions}`)

  for (const c of grammar.collisions) {
    console.log(
      `    ${c.half} ${c.name}: ${c.files.map(f => relative(MILL, f)).join(', ')}`,
    )
  }

  console.log(
    `  mine rules with no mint: ${report.missingMints.length}`,
  )

  if (report.missingMints.length > 0) {
    console.log(`    ${report.missingMints.join(', ')}`)
  }

  console.log(
    `  mints referenced but unreachable: ${report.danglingMints.length}`,
  )

  if (report.danglingMints.length > 0) {
    console.log(`    ${report.danglingMints.join(', ')}`)
  }

  const droppedSites = report.unreadSites.reduce(
    (n, r) => n + r.sites.length,
    0,
  )
  console.log(
    `  sites filled but never read (content dropped): ${droppedSites} across ${report.unreadSites.length} rules`,
  )

  for (const r of report.unreadSites.slice(0, verbose ? 999 : 12)) {
    console.log(`    ${r.rule}: ${r.sites.join(', ')}`)
  }

  const deadCount = report.deadCases.reduce((n, r) => n + r.cases.length, 0)
  console.log(
    `  mint cases reading a site the mine never fills: ${deadCount} across ${report.deadCases.length} rules`,
  )

  for (const r of report.deadCases.slice(0, verbose ? 999 : 12)) {
    console.log(`    ${r.rule}: ${r.cases.join(', ')}`)
  }

  const shadowed = shadowedAlternatives(grammar.mine)
  console.log(
    `  alternatives a greedy one makes unreachable: ${shadowed.length}`,
  )

  for (const line of shadowed.slice(0, verbose ? 999 : 12)) {
    console.log(`    ${line}`)
  }

  // ---- programs ----

  const roles = new Map<string, string | undefined>()
  // A file whose role rule carries `mark lean` is read with the lean surface, as the compiler reads it
  // (compile/mill.ts): the role's lean flag and the grammar's `mark lean` rules both go to the bridge. Without them a
  // lean property head is built as a call, and a head that names a statement (`note(note)`, a field called `note` in
  // deck/call/code/work/hook/parsing.tree) is refused, though the build reads it (item term-self-host-001-1224).
  const leans = new Map<string, boolean>()
  const leanRules = readLeanRules(
    parse({ file: 'mine.tree', text: grammar.mineText }).tree as never,
  )
  const leanGrammar = { ...grammar, lean: leanRules }
  const leanOf = new Map<string, ReturnType<typeof projectLeanOf>>()
  const leanFor = (pkg: string): ReturnType<typeof projectLeanOf> => {
    const known = leanOf.get(pkg)

    if (known) {
      return known
    }

    const made = projectLeanOf(join(DECK, pkg))
    leanOf.set(pkg, made)

    return made
  }

  // A package's `role.tree` says which mill reads which file. A file whose role is not `code` is read by a
  // different grammar, so comparing it against the code role would answer the wrong question. This is the
  // compiler's own resolver.
  const roleOf = new Map<string, ReturnType<typeof projectRoleOf>>()
  const roleFor = (pkg: string): ReturnType<typeof projectRoleOf> => {
    const known = roleOf.get(pkg)

    if (known) {
      return known
    }

    const made = projectRoleOf(join(DECK, pkg))
    roleOf.set(pkg, made)

    return made
  }
  const files: string[] = []

  for (const name of packagesUnder(DECK)) {
    const code = join(DECK, name, 'code')

    if (!existsSync(code)) {
      continue
    }

    for (const file of walk(code)) {
      // the file's role goes to BOTH readers: `role site` and `role call` change what a `hook` means, and a
      // reader that is not told cannot answer the same way
      roles.set(file, roleFor(name)(file) ?? undefined)
      leans.set(file, leanFor(name)(file))
      files.push(file)
    }
  }

  const pool = files.filter(f => (only ? f.includes(only) : true))
  let same = 0
  let differ = 0
  let draft = 0
  let parseFail = 0
  let bridgeFail = 0
  let millFail = 0
  const shown: string[] = []
  // per node kind: how many the reference program holds, and how many the bridge reproduced
  const wanted = new Map<string, number>()
  const got = new Map<string, number>()
  // what the bridge said it could not build, tallied: the work list, in the order it pays to do it
  const blockers = new Map<string, number>()
  const skipped: string[] = []
  const blockerFile = new Map<string, string>()
  // difference paths with their indices stripped: the work list for the files that DO build
  const paths = new Map<string, number>()

  for (const file of pool) {
    const source = readFileSync(file, 'utf8')

    if (/^(mark|note) draft$/m.test(source)) {
      draft++
      continue
    }

    // a format grammar's `mine.tree` (deck/mill/code/text, blob) is no program: the build generates the reader it
    // describes and mills THAT (call/code/make.ts `buildable`), so this compares what the build compiles. Milling the
    // grammar itself as code read the LaTeX grammar's `send` rename as a call to a task named `send` (2026-10-06)
    const asBuilt = buildable(file, source, roles.get(file))

    if ('faults' in asBuilt) {
      skipped.push(`${relative(DECK, file)}: a grammar the build refuses (${asBuilt.faults.join(', ')})`)
      continue
    }

    const text = asBuilt.generated ? asBuilt.text : source

    const skip =
      NAMED_SKIP[relative(DECK, file)] ??
      (inViewDialect(text)
        ? 'the face / tone look dialect, which the code role does not read'
        : undefined)

    if (skip) {
      skipped.push(`${relative(DECK, file)}: ${skip}`)
      continue
    }

    const parsed = parse({ file, text })

    if (!parsed.ok) {
      parseFail++
      // name it: a count alone sent the reader searching 4,500 files for the one (2026-10-02)
      console.log(`    parse fail  ${relative(DECK, file)}: ${parsed.diagnostics[0]?.message ?? ''}`)
      continue
    }

    // the compiler expands `tree` / `fuse` templates BEFORE the mill (compile.ts), so both paths are handed the
    // expanded tree. Comparing on the raw parse would chase parity on input the compiler never produces: an
    // unexpanded `tree` reaches the mill's generic fallback and lowers to a nonsense call expression.
    const expanded = expandTemplates(parsed.tree)
    const role = roles.get(file)
    const reference = millByHand?.(expanded, file, role)

    if (reference && !reference.ok) {
      millFail++
      continue
    }

    if (reference?.ok) {
      for (const [kind, n] of censusProgram(reference.program)) {
        wanted.set(kind, (wanted.get(kind) ?? 0) + n)
      }
    }

    const built = millByGrammar(
      expanded,
      file,
      role,
      leanGrammar,
      leans.get(file) === true,
    )

    if (!built.ok) {
      bridgeFail++

      for (const d of built.diagnostics) {
        const reason = d.message ?? 'unknown'
        blockers.set(reason, (blockers.get(reason) ?? 0) + 1)
        // the FILE a blocker first appeared in, so the report names something to open
        if (!blockerFile.has(reason)) {
          blockerFile.set(reason, relative(DECK, file))
        }
      }

      continue
    }

    for (const [kind, n] of censusProgram(built.program)) {
      got.set(kind, (got.get(kind) ?? 0) + n)
    }

    if (!reference?.ok) {
      same++
      continue
    }

    const diffs = diffCanonical(
      canonical(reference.program),
      canonical(built.program),
      4,
    )

    if (diffs.length === 0) {
      same++
      continue
    }

    differ++

    // the SHAPE of each difference, with array indices dropped, so the report names a pattern
    // ("every record-type's field type") rather than nine hundred individual paths
    for (const d of diffs) {
      const shape = d.path.replace(/\[\d+\]/g, '[]')
      paths.set(shape, (paths.get(shape) ?? 0) + 1)
    }

    if (shown.length < limit) {
      shown.push(
        `  ${relative(DECK, file)}\n${diffs
          .map(d => `      ${d.path}\n        retired: ${d.left}\n        grammar: ${d.right}`)
          .join('\n')}`,
      )
    }
  }

  console.log('')
  console.log('mint-parity: programs')
  console.log(
    REFERENCE
      ? `  ${same} identical, ${differ} differ, ${bridgeFail} the grammar could not build, ${millFail} the retired reader could not build, ${parseFail} parse fail, ${draft} draft-skipped, ${skipped.length} named skips`
      : `  ${same} built, ${bridgeFail} the grammar could not build, ${parseFail} parse fail, ${draft} draft-skipped, ${skipped.length} named skips  (--reference also diffs the retired reader)`,
  )

  for (const reason of skipped) {
    console.log(`    skip  ${reason}`)
  }

  if (REFERENCE) {
    const kinds = [...new Set([...wanted.keys(), ...got.keys()])].sort()
    const behind = kinds
      .map(k => ({
        kind: k,
        want: wanted.get(k) ?? 0,
        have: got.get(k) ?? 0,
      }))
      .filter(k => k.want !== k.have)
      .sort((a, b) => Math.abs(b.want - b.have) - Math.abs(a.want - a.have))

    console.log(
      `  node kinds: ${kinds.length - behind.length} of ${kinds.length} at the right count`,
    )

    for (const k of behind.slice(0, verbose ? 999 : 15)) {
      console.log(
        `    ${k.kind}: retired reader ${k.want}, grammar ${k.have}`,
      )
    }
  }

  if (blockers.size > 0) {
    console.log('')
    console.log('  what the bridge cannot build yet, by how often it blocks a file:')

    for (const [reason, n] of [...blockers.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, verbose ? 999 : 20)) {
      console.log(
        `    ${String(n).padStart(5)}  ${reason}  (e.g. ${blockerFile.get(reason) ?? '?'})`,
      )
    }
  }

  if (paths.size > 0) {
    console.log('')
    console.log('  where the built programs differ, by how many files show it:')

    for (const [shape, n] of [...paths.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, verbose ? 999 : 20)) {
      console.log(`    ${String(n).padStart(5)}  ${shape}`)
    }
  }

  if (shown.length > 0) {
    console.log('')
    console.log('  first differences:')

    for (const s of shown) {
      console.log(s)
    }
  }

  const failed =
    !bakedFresh ||
    report.collisions > 0 ||
    grammar.problems.length > 0 ||
    differ > 0 ||
    bridgeFail > 0 ||
    parseFail > 0

  console.log('')
  console.log(
    `mint-parity: ${same} pass, ${differ + bridgeFail + parseFail} fail, ${draft} draft-skipped, ${skipped.length} named skips`,
  )

  if (failed) {
    process.exitCode = 1
  }
}

main().catch((cause: unknown) => {
  console.error(cause)
  process.exitCode = 1
})
