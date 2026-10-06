// The `mill` role: a file that DEFINES a dialect (`deck/mill/code/<dialect>/{base,mine,mint}.tree`), read as one.
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
// The `mill` mill itself (deck/mill/code/mill, `mill mill`) is not the reader here: on 2026-10-02 it read 3 of the
// 344 files under deck/mill/code (its `bind mine, load ./mine` rule wants a text path, every base.tree writes a
// name), so holding a file to it would report a defect in the meta-grammar on every file.

import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import { parse } from '@term/make/code/parser/tree'
import type { Node } from '@term/make/code/parser/tree'
import type { GroupNode } from '@term/make/code/parser/narrow'
import { groupsOf } from '@term/make/code/parser/narrow'
import { spanOfWhole } from '@term/make/code/compile/mill-run'
import type { Source } from '@term/make/code/compile/load'

// the heads whose second word a mill definition DECLARES, so a `find` of it resolves
const DECLARING = new Set(['form', 'task', 'mine', 'mint', 'mill', 'bind', 'mask', 'host', 'tree'])

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
  const parsed = parse(source)
  const names = new Set<string>()

  if (!parsed.ok) {
    return [...names]
  }

  for (const group of groupsOf(parsed.tree.nodes)) {
    if (DECLARING.has(headOf(group))) {
      names.add(wordOf(group.nodes[1]))
    }
  }

  return [...names]
}

// As compile/mill-check.tree answers it: resolving is the caller's IO. What each top-level `load` asks for, in order
export function millLoadTargets(source: Source): string[] {
  const parsed = parse(source)

  return parsed.ok ? groupsOf(parsed.tree.nodes).filter(group => headOf(group) === 'load').map(group => wordOf(group.nodes[1])) : []
}

export type MillLoad = { target: string; found?: Source }

export type MillProblem = { what: string; span: Span }

// The four checks, as problems. A caller that cannot resolve (`resolving` false) skips the three that need it, and
// says nothing it cannot know. `resolved` answers `millLoadTargets`, one per target, in its order
export function checkMillDefinition(
  source: Source,
  resolving: boolean,
  resolved: MillLoad[],
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
  }

  return {
    parsed: true,
    problems,
    diagnostics: problems.map(problem =>
      diagnose('unknown-name', {
        file: source.file,
        span: { ...problem.span, file: source.file },
        message: `this mill definition ${problem.what}`,
        hint: 'a mill definition loads grammar files and the stdlib forms its mints build: name one that exists',
      }),
    ),
  }
}
