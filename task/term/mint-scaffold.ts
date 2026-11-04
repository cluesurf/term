// Bring every mint in a role up to its mine: one `case` per site the mine fills, in the mine's own order.
//
// The mints drifted. `mine like` fills `name`, `or`, `and`, `task`; `mint like` read a site called `value` that
// no mine has filled for a long time, so every `like` annotation in the stdlib minted to nothing, silently.
// That is the same silent-loss failure the whole mill rule exists to prevent, one level up. This regenerates
// the case list from the mine grammar, which is the authority on what a rule captures.
//
// WHAT IT PRESERVES, because these are design decisions and not drift:
//   - whether a mint builds a form (`hook make`) or passes its branch through (an alternation)
//   - the `like <form>` annotation, which is what `pnpm term:mill-forms` reads to generate lang.tree
//   - the form name a `make` builds
//
// WHAT IT WRITES: the `case` list, and the `bind` list of a `make`, so no site can be dropped.
//
// A case does NOT name its mint. `runMint` falls back to the mine rule that produced the capture, so leaving it
// off keeps the mint correct when the mine adds a branch. `pnpm term:mint-parity` holds the fallback honest by
// refusing a referenced mint that is not reachable.
//
// Run from the Term root. Reports by default; writes only with `--commit`.

import {
  writeFileSync,
  readdirSync,
  statSync,
  rmSync,
} from 'node:fs'
import { join, dirname, relative } from 'node:path'
import {
  loadRoleGrammar,
  readGrammarFile,
} from '@term/make/code/compile/mill-load'
import type { GrammarFile } from '@term/make/code/compile/mill-load'
import type { MineRule } from '@term/make/code/compile/mill-run'
import { TERM_ROOT } from './root'

const TERM = TERM_ROOT
const MILL = join(TERM, 'deck/mill/code/tree')
const ROLE = process.argv.find(a => a.startsWith('--role='))?.slice(7) ?? 'code'
const commit = process.argv.includes('--commit')
const ROOT = join(MILL, ROLE)

// The sites a rule fills, in the order the mine fills them (order is what makes a generated file readable and
// its diff stable), each with the RULES that fill it.
//
// A site filled by exactly one named rule whose name differs from the site's needs an explicit `, mint <rule>`:
// `runMint` falls back to the rule name, so `mine form, like view-def / site view` would look for `mint
// view-def` and find nothing. A site filled by several rules (an alternation capturing to one site) must NOT
// name a mint, because the right one differs per capture and the fallback picks it.
function sitesOf(
  rules: MineRule[],
  into = new Map<string, Set<string>>(),
): Map<string, Set<string>> {
  for (const rule of rules) {
    if ('children' in rule && rule.children.length > 0) {
      sitesOf(rule.children, into)
    }

    if ('site' in rule && rule.site) {
      const fills = into.get(rule.site) ?? new Set<string>()

      if (rule.kind === 'form') {
        fills.add(rule.like)
      }

      into.set(rule.site, fills)
    }
  }

  return into
}

// the mint a case should name, or undefined to let the fallback pick
function mintFor(site: string, fills: Set<string>): string | undefined {
  if (fills.size !== 1) {
    return undefined
  }

  const only = [...fills][0]!

  return only === site ? undefined : only
}

// a rule whose whole body is one alternation over other rules carries no shape of its own: its branch's value
// rides out unchanged. Those mints have no `make`, and generating one would bury the branch a level deeper.
function isPassThrough(rules: MineRule[]): boolean {
  if (rules.length !== 1) {
    return false
  }

  const only = rules[0]!

  return (
    only.kind === 'any' &&
    only.children.every(child => child.kind === 'form')
  )
}

function walk(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)

    if (statSync(path).isDirectory()) {
      walk(path, into)
    } else if (name === 'mint.tree' || name === 'mine.tree') {
      into.push(path)
    }
  }

  return into
}

type Existing = {
  file: string
  like?: string
  makeForm?: string
  hasMake: boolean
  from: number
  to: number
}

// what a `mint <name>` block already decided, so regeneration keeps it. Read from the parse tree, never with a
// pattern over the source: one parser (note/project/term/one-parser.md).
function findExisting(
  files: string[],
  name: string,
  read: (file: string) => GrammarFile | undefined,
): Existing | undefined {
  for (const file of files) {
    const grammar = read(file)
    const rule = grammar?.rules.find(r => r.half === 'mint' && r.name === name)

    if (!grammar || !rule) {
      continue
    }

    return {
      file,
      like: rule.like,
      makeForm: rule.makeForm,
      hasMake: rule.makeForm !== undefined,
      from: rule.from,
      to: rule.to,
    }
  }

  return undefined
}

function render(
  name: string,
  sites: [string, Set<string>][],
  like: string | undefined,
  makeForm: string | undefined,
): string {
  const head = like ? `mint ${name}, like ${like}` : `mint ${name}`
  const cases = sites.map(([site, fills]) => {
    const mint = mintFor(site, fills)

    return `  case ${site}${mint ? `, mint ${mint}` : ''}\n    site ${site}`
  })

  if (!makeForm) {
    return [head, ...cases].join('\n')
  }

  const binds = sites.map(([site]) => `      bind ${site}, read ${site}`)

  return [
    head,
    ...cases,
    '  hook make',
    `    make ${makeForm}`,
    ...binds,
  ].join('\n')
}

function main(): void {
  const grammar = loadRoleGrammar(MILL, ROLE)
  const files = walk(ROOT)
  const mintFiles = files.filter(f => f.endsWith('mint.tree'))
  const edits = new Map<string, string>()

  // one parse per file, reused: every question about a grammar file is answered from its tree
  const cache = new Map<string, GrammarFile | undefined>()
  const read = (file: string): GrammarFile | undefined => {
    const pending = edits.get(file)

    if (pending !== undefined) {
      // a file this run already rewrote: re-read it from the edited text through the parser
      const scratch = join(ROOT, '.mint-scaffold-scratch.tree')
      writeFileSync(scratch, pending)
      const grammarOf = readGrammarFile(scratch)
      rmSync(scratch)

      return grammarOf ? { ...grammarOf, file, text: pending } : undefined
    }

    if (!cache.has(file)) {
      cache.set(file, readGrammarFile(file))
    }

    return cache.get(file)
  }
  const textOf = (file: string): string =>
    edits.get(file) ?? read(file)?.text ?? ''

  // the file that defines each mine rule, so a new mint lands beside its mine
  const mineHome = new Map<string, string>()

  for (const file of files.filter(f => f.endsWith('mine.tree'))) {
    for (const rule of read(file)?.rules ?? []) {
      if (rule.half === 'mine' && !mineHome.has(rule.name)) {
        mineHome.set(rule.name, file)
      }
    }
  }

  let repaired = 0
  let created = 0

  for (const [name, rules] of grammar.mine) {
    // A rule that captures nothing is still worth minting: it is a MARKER (`mark unsafe`, a `hook` whose
    // presence is the whole meaning), and the form its mint builds is how that presence reaches the AST. Left
    // unminted, the capture vanishes and the task silently stops being unsafe.
    const sites = [...sitesOf(rules)]
    const existing = findExisting(mintFiles, name, read)
    const passThrough = existing ? !existing.hasMake : isPassThrough(rules)
    // The form a mint builds is named for its RULE. It has to be: the bridge that turns minted values into
    // compiler nodes switches on the form name, and four different rules used to build a form called `save`
    // with four different field sets, which no switch can tell apart.
    const makeForm = passThrough ? undefined : name
    const built = render(name, sites, existing?.like, makeForm)

    if (existing) {
      const lines = textOf(existing.file).split('\n')
      const before = lines.slice(0, existing.from).join('\n')
      const after = lines.slice(existing.to).join('\n')
      const whole = [before, built, after]
        .filter(part => part !== '')
        .join('\n')

      if (whole === textOf(existing.file)) {
        continue
      }

      edits.set(existing.file, whole)
      repaired++
      continue
    }

    const home = mineHome.get(name)

    if (!home) {
      continue
    }

    const target = join(dirname(home), 'mint.tree')
    const text = textOf(target)
    edits.set(
      target,
      `${text.replace(/\n*$/, '')}\n\n${built}\n`.replace(/^\n+/, ''),
    )

    if (!mintFiles.includes(target)) {
      mintFiles.push(target)
    }

    created++
  }

  // ---- the load blocks ----
  // A mint file must load every mint it reaches, explicitly or through the rule-name fallback, or the merge
  // silently leaves those rules out and the sites they would have read mint to nothing. Regenerated here from
  // the same authority that wrote the cases, so the two cannot drift apart.
  const defines = new Map<string, string>()

  for (const file of new Set([...mintFiles, ...edits.keys()])) {
    for (const rule of read(file)?.rules ?? []) {
      if (rule.half === 'mint' && !defines.has(rule.name)) {
        defines.set(rule.name, file)
      }
    }
  }

  // what each rule reaches: the explicit mint of a case, else every rule that fills that case's site
  const reaches = new Map<string, Set<string>>()

  for (const [name, rules] of grammar.mine) {
    const out = new Set<string>()

    for (const [site, fills] of sitesOf(rules)) {
      const explicit = mintFor(site, fills)

      if (explicit) {
        out.add(explicit)
      } else {
        for (const fill of fills) {
          out.add(fill)
        }
      }
    }

    reaches.set(name, out)
  }

  let blocks = 0

  for (const file of new Set([...mintFiles, ...edits.keys()])) {
    const grammarOf = read(file)

    if (!grammarOf) {
      continue
    }

    // drop the existing grammar load block by LINE, located by the parser
    const kept = textOf(file)
      .split('\n')
      .filter((_, i) => !grammarOf.grammarLoadLines.has(i))
      .join('\n')
      .replace(/^\n+/, '')
    const own = new Set(
      grammarOf.rules.filter(r => r.half === 'mint').map(r => r.name),
    )
    const needed = new Set<string>()

    for (const rule of own) {
      for (const target of reaches.get(rule) ?? []) {
        if (!own.has(target) && defines.has(target)) {
          needed.add(target)
        }
      }
    }

    if (needed.size === 0) {
      if (kept !== textOf(file)) {
        edits.set(file, kept)
      }

      continue
    }

    const byFile = new Map<string, string[]>()

    for (const target of [...needed].sort()) {
      const home = defines.get(target)!
      const list = byFile.get(home) ?? []
      list.push(target)
      byFile.set(home, list)
    }

    const block = [...byFile.entries()]
      .map(([home, names]) => {
        const rel = relative(ROOT, home).replace(/\/?mint\.tree$/, '')
        const path = rel === '' ? '' : `/${rel}`

        return `load @term/mill/tree/${ROLE}${path}/mint\n${names
          .sort()
          .map(n => `  find ${n}\n`)
          .join('')}`
      })
      .sort()
      .join('\n')

    const whole = `${block}\n${kept.startsWith('#') ? '\n' : ''}${kept}`

    if (whole === textOf(file)) {
      continue
    }

    edits.set(file, whole)
    blocks++
  }

  console.log(
    `mint-scaffold: ${repaired} mints repaired, ${created} created, ${blocks} load blocks written, across ${edits.size} files`,
  )

  for (const [file, text] of edits) {
    if (commit) {
      writeFileSync(file, text)
    } else {
      console.log(`  would write ${relative(ROOT, file)}`)
    }
  }

  if (!commit) {
    console.log('mint-scaffold: report only, pass --commit to write')
  }
}

main()
