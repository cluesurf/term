// The `mill` role: a file that DEFINES a dialect (`deck/mill/code/tree/<dialect>/{base,mine,mint}.tree`), read as one.
//
// A mill definition is not a program. Its heads are `mill`, `mine` and `mint`, its `load` lines bring in other
// grammar files and the stdlib forms a `mint ..., like <form>` builds, and nothing executes it: the toolchain reads
// it with `readMineGrammar` / `readMintGrammar` (compile/mill-load.ts, compile/mill-run.ts) when a role's grammar
// is assembled or baked. Milled as CODE, every `mine` and `mint` reads as a call to an undefined task and every
// grammar file it loads is compiled as code too, which is how one open `fork/mine.tree` showed over a thousand
// errors in the editor.
//
// So this is what a mill definition owes, and the whole of it. Nothing here is a second grammar of the dialect:
// the file must PARSE (the one parser), every `load` must RESOLVE (the caller's resolver, the build's own), every
// `find` must name something its target declares at the top level, and every `mint <x>, like <form>` must name a
// form a load of the file brings in. test/compile/mill-grammar.ts holds every file under deck/mill/code to the
// same four checks through this function, so the editor and the gate cannot disagree about a grammar file.
//
// Decision 003 of note/project/term/module-scope adds two. Rule 2: a form the grammar hands to Term (`mint N, like F`,
// `hook make / make F`) is reached by a `find F` under a load of its module, exactly as a Term file's reference is,
// and that IS the unimported-name refusal for grammar files; it needs the form's definers, which only a caller with a
// program or an index knows (`MillContext`). Rule 3: grammar vocabulary resolves in the grammar, so every `mine K` is
// a matcher kind the mine reader accepts, and a `mine form, like R` or `case X, mint Y` names a rule of the role's
// load closure (the caller's `closure`). The census (task/term/scope-census.ts) reads a grammar file's references
// from `millFormReferences` here, never by milling it as Term.
//
// The `mill` mill itself (deck/mill/code/tree/mill, `mill mill`) is not the reader here: on 2026-10-02 it read 3 of the
// 344 files under deck/mill/code (its `bind mine, load ./mine` rule wants a text path, every base.tree writes a
// name), so holding a file to it would report a defect in the meta-grammar on every file.

import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import { parse } from '@term/make/code/parser/tree'
import type { Node } from '@term/make/code/parser/tree'
import type { GroupNode } from '@term/make/code/parser/narrow'
import { groupsOf } from '@term/make/code/parser/narrow'
import { readMineGrammar, spanOfWhole } from '@term/make/code/compile/mill-run'
import type { Source } from '@term/make/code/compile/load'

// the heads whose second word a mill definition DECLARES, so a `find` of it resolves
const DECLARING = new Set(['form', 'task', 'mine', 'mint', 'mill', 'bind', 'mask', 'host', 'tree'])

// the heads that declare a Term FORM, the thing a `mint ..., like F` or a `hook make / make F` hands to Term
// (note/project/term/module-scope/decision/003-grammar-files-reference-only-forms.md, rule 2)
const FORM_DECLARING = new Set(['form', 'mask'])

function wordOf(node: Node | undefined): string {
  if (node?.kind === 'name') {
    return node.parts.map(p => (p.kind === 'chunk' ? p.text : '')).join('')
  }

  if (node?.kind === 'group') {
    return wordOf(node.nodes[0])
  }

  return ''
}

const headOf = (group: GroupNode): string => wordOf(group.nodes[0])

// the names a source declares at its top level, each once, in order
export function millDeclared(source: Source): string[] {
  return declaredBy(source, DECLARING)
}

// the FORMS a source declares at its top level (`form`, `mask`), each once, in order: what a grammar's form reference
// must find. A gate builds its index of form definers from this, so it reads a definition exactly as this file does
export function millDeclaredForms(source: Source): string[] {
  return declaredBy(source, FORM_DECLARING)
}

function declaredBy(source: Source, heads: Set<string>): string[] {
  const parsed = parse(source)
  const names = new Set<string>()

  if (!parsed.ok) {
    return [...names]
  }

  for (const group of groupsOf(parsed.tree.nodes)) {
    if (heads.has(headOf(group))) {
      names.add(wordOf(group.nodes[1]))
    }
  }

  return [...names]
}

// A Term name a grammar hands to Term (decision 003 rule 2): the form of `mint N, like F`, and the form of
// `hook make / make F`, the minted record's tag. `found` is whether a `find F` under a `load` of a module that DECLARES
// F as a form reaches it, which is the only thing that binds it: a `load` alone, or a `find` of a grammar rule that
// happens to share the name (`load .../bind/mint` / `find bind` reaches the mint rule, never the form), does not.
// `loads` are the targets this file already loads that declare F as a form, so a diagnostic can name the find to add
export type MillFormReference = { name: string; how: 'like' | 'make'; span: Span; found: boolean; loads: string[] }

export function millFormReferences(source: Source, resolved: MillLoad[]): MillFormReference[] {
  const tree = parse(source)

  return tree.ok ? formReferencesOf(tree.tree.nodes, resolved) : []
}

function formReferencesOf(nodes: Node[], resolved: MillLoad[]): MillFormReference[] {
  // form name -> whether a find reaches it, and the loads that declare it
  const found = new Set<string>()
  const declaring = new Map<string, string[]>()
  let loadAt = 0

  for (const group of groupsOf(nodes)) {
    if (headOf(group) !== 'load') {
      continue
    }

    const target = wordOf(group.nodes[1])
    const answer = resolved[loadAt++]?.found

    if (!answer) {
      continue
    }

    const forms = new Set(millDeclaredForms(answer))

    for (const name of forms) {
      declaring.set(name, [...(declaring.get(name) ?? []), target])
    }

    for (const child of group.nodes.slice(2)) {
      if (child.kind === 'group' && headOf(child) === 'find' && forms.has(wordOf(child.nodes[1]))) {
        found.add(wordOf(child.nodes[1]))
      }
    }
  }

  const out: MillFormReference[] = []
  const add = (name: string, how: 'like' | 'make', at: Node): void => {
    out.push({ name, how, span: spanOfWhole(at), found: found.has(name), loads: declaring.get(name) ?? [] })
  }

  for (const group of groupsOf(nodes)) {
    if (headOf(group) !== 'mint') {
      continue
    }

    for (const child of group.nodes.slice(2)) {
      if (child.kind !== 'group') {
        continue
      }

      const head = headOf(child)

      // a mint NAMED `like` reads as an empty like-group; only a like clause with an argument names the built form
      if (head === 'like' && wordOf(child.nodes[1])) {
        add(wordOf(child.nodes[1]), 'like', child)
      }

      // `hook make`: the hook's own `make` word is a bare marker, the construction is the make group WITH content
      // (compile/mill-running.tree read-mint-grammar)
      if (head === 'hook' && wordOf(child.nodes[1]) === 'make') {
        for (const inner of child.nodes.slice(1)) {
          if (inner.kind === 'group' && headOf(inner) === 'make' && inner.nodes.length > 1 && wordOf(inner.nodes[1])) {
            add(wordOf(inner.nodes[1]), 'make', inner)
          }
        }
      }
    }
  }

  return out
}

// The rule names one role's grammar defines, its load closure merged (compile/mill-load.ts loadRoleGrammar): what a
// `mine form, like R` and a `case X, mint Y` must name (decision 003 rule 3). A caller passes the closure of every role
// whose grammar holds the file, intersected, since a rule another role lacks dangles there
export type MillClosure = { mine: ReadonlySet<string>; mint: ReadonlySet<string> }

// what a gate knows beyond the file: the definers of a form, by the name the diagnostic shows (a name no module defines
// is a mint-bridge tag, not a Term name, and is no reference), and the closure of the roles the file is in
export type MillContext = { formDefiners?: (name: string) => string[]; closure?: MillClosure }

// A matcher kind is what the mine reader itself accepts. Asked of it, never copied: a one-rule probe grammar written
// with the kind is read by readMineGrammar (compile/mill-running.tree read-mine-rule), which drops an unknown kind
const KINDS = new Map<string, boolean>()

export function isMatcherKind(kind: string): boolean {
  const known = KINDS.get(kind)

  if (known !== undefined) {
    return known
  }

  let answer = false

  if (/^[a-z][a-z0-9-]*$/.test(kind)) {
    const probe = parse({ file: 'matcher-kind-probe.tree', text: `mine probe\n  mine ${kind}, like probe\n` })
    answer = probe.ok && (readMineGrammar(probe.tree).get('probe')?.length ?? 0) === 1
  }

  KINDS.set(kind, answer)

  return answer
}

// rule 3: every matcher a `mine` rule nests is a known kind, a `mine form` names a rule of the closure, and every
// `case X, mint Y` of a `mint` names a mint rule of the closure
function ruleProblemsOf(nodes: Node[], closure: MillClosure): MillProblem[] {
  const problems: MillProblem[] = []

  const matcher = (group: GroupNode): void => {
    const kind = wordOf(group.nodes[1])

    if (!isMatcherKind(kind)) {
      problems.push({ what: `matches with "mine ${kind}", which is no matcher kind`, span: spanOfWhole(group) })
    } else if (kind === 'form') {
      const like = group.nodes.slice(2).find(n => n.kind === 'group' && headOf(n) === 'like') as GroupNode | undefined
      const rule = like ? wordOf(like.nodes[1]) : ''

      if (!rule) {
        problems.push({ what: 'matches "mine form" with no "like <rule>"', span: spanOfWhole(group) })
      } else if (!closure.mine.has(rule)) {
        problems.push({ what: `matches "mine form, like ${rule}", which its grammar defines no mine rule for`, span: spanOfWhole(group) })
      }
    }

    for (const child of group.nodes.slice(2)) {
      if (child.kind === 'group' && headOf(child) === 'mine') {
        matcher(child)
      }
    }
  }

  for (const group of groupsOf(nodes)) {
    const head = headOf(group)

    if (head === 'mine') {
      for (const child of group.nodes.slice(2)) {
        if (child.kind === 'group' && headOf(child) === 'mine') {
          matcher(child)
        }
      }
    }

    if (head === 'mint') {
      for (const child of group.nodes.slice(2)) {
        if (child.kind !== 'group' || headOf(child) !== 'case') {
          continue
        }

        // read-mint-grammar: the `mint` group after the case's head and name
        const mint = child.nodes.slice(2).find(n => n.kind === 'group' && headOf(n) === 'mint') as GroupNode | undefined
        const rule = mint ? wordOf(mint.nodes[1]) : ''

        if (rule && !closure.mint.has(rule)) {
          problems.push({ what: `mints a case through "mint ${rule}", which its grammar defines no mint rule for`, span: spanOfWhole(mint!) })
        }
      }
    }
  }

  return problems
}

// As compile/mill-check.tree answers it: resolving is the caller's IO. What each top-level `load` asks for, in order
export function millLoadTargets(source: Source): string[] {
  const parsed = parse(source)

  return parsed.ok ? groupsOf(parsed.tree.nodes).filter(group => headOf(group) === 'load').map(group => wordOf(group.nodes[1])) : []
}

export type MillLoad = { target: string; found?: Source }

export type MillProblem = { what: string; span: Span; hint?: string }

const LOAD_HINT = 'a mill definition loads grammar files and the stdlib forms its mints build: name one that exists'

// The checks, as problems. A caller that cannot resolve (`resolving` false) skips the ones that need it, and says
// nothing it cannot know. `resolved` answers `millLoadTargets`, one per target, in its order. A `context` with form
// definers adds rule 2 (every form reference found), one with a closure rule 3 (matcher kinds, and every rule a
// grammar names defined in its closure), both of decision 003
export function checkMillDefinition(
  source: Source,
  resolving: boolean,
  resolved: MillLoad[],
  context: MillContext = {},
): { parsed: boolean; problems: MillProblem[]; diagnostics: Diagnostic[] } {
  const tree = parse(source)

  if (!tree.ok) {
    return { parsed: false, problems: [], diagnostics: tree.diagnostics }
  }

  const problems: MillProblem[] = []

  if (resolving) {
    // the forms the file's loads bring in, for the `like` checks
    const known = new Set<string>()
    let loadAt = 0

    for (const group of groupsOf(tree.tree.nodes)) {
      if (headOf(group) !== 'load') {
        continue
      }

      const target = wordOf(group.nodes[1])
      const found = resolved[loadAt++]?.found

      if (!found) {
        problems.push({ what: `loads "${target}", which does not exist`, span: spanOfWhole(group) })
        continue
      }

      const names = new Set(millDeclared(found))

      for (const child of group.nodes.slice(2)) {
        if (child.kind !== 'group' || headOf(child) !== 'find') {
          continue
        }

        const name = wordOf(child.nodes[1])

        if (!names.has(name)) {
          problems.push({
            what: `finds "${name}" in "${target}", which declares no such thing`,
            span: spanOfWhole(child),
          })
        } else {
          known.add(name)
        }
      }
    }

    for (const group of groupsOf(tree.tree.nodes)) {
      if (headOf(group) !== 'mint') {
        continue
      }

      const like = group.nodes.find(n => n.kind === 'group' && headOf(n) === 'like') as GroupNode | undefined
      // a mint NAMED `like` (the type-annotation head's own mint) reads as an empty like-group here; only a like
      // clause with an argument names the built form
      const likeName = like ? wordOf(like.nodes[1]) : ''

      if (likeName && !known.has(likeName)) {
        problems.push({
          what: `mints "like ${likeName}", which no load of this file brings in`,
          span: spanOfWhole(like!),
        })
      }
    }

    // rule 2: a form the grammar hands to Term is reached by a `find` of it under a load of its module, exactly as
    // in a Term file. A name no module defines is a mint-bridge tag and no reference
    const definersOf = context.formDefiners

    if (definersOf) {
      for (const ref of formReferencesOf(tree.tree.nodes, resolved)) {
        // a `like` no load brings in at all is reported above, once
        const definers = ref.found || (ref.how === 'like' && !known.has(ref.name)) ? [] : definersOf(ref.name)

        if (definers.length === 0) {
          continue
        }

        const where = ref.loads.length > 0 ? ref.loads : definers
        problems.push({
          what: `${ref.how}s "${ref.name}", a form of ${definers.join(', ')} that no find of this file reaches`,
          span: ref.span,
          hint: `import it as a Term file would: load ${where[0]} / find ${ref.name}`,
        })
      }
    }
  }

  // rule 3 runs for a caller that knows the closure: held to zero by the gate once the grammar files meet it, before
  // the editor and the build see it (module-scope-0006)
  if (context.closure) {
    problems.push(...ruleProblemsOf(tree.tree.nodes, context.closure))
  }

  return {
    parsed: true,
    problems,
    diagnostics: problems.map(problem =>
      diagnose('unknown-name', {
        file: source.file,
        span: { ...problem.span, file: source.file },
        message: `this mill definition ${problem.what}`,
        hint: problem.hint ?? LOAD_HINT,
      }),
    ),
  }
}
