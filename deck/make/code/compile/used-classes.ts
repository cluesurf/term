// Tailwind JIT, step one: scan a milled program for the utility classes it actually uses. It walks every zone
// component's elements and collects the literal `class` attribute tokens (`bind class, text <flex gap-2 md:flex>` ->
// flex, gap-2, md:flex). Only string literals are collected: a dynamic `class` (a `read`/`call`) can name any class, so
// those are reported separately as the "dynamic" escape so the build can fall back to the full catalog if needed.
//
// This pairs with the incremental query graph (compile/incremental.ts): a `usedClasses` query derived from the milled
// program backdates while the class set is unchanged, so editing a component recomputes the stylesheet only when its
// classes actually change -- no reparse of anything else. See note/library/face/tailwind-jit.md.

import type { Program, ZoneNode } from '@cluesurf/make/code/compile/node'

export type UsedClasses = {
  // the sorted set of statically-known class tokens (the JIT keep-list)
  classes: string[]
  // whether any element has a non-literal `class` (so the JIT cannot be sure it saw every class)
  dynamic: boolean
}

function walk(
  nodes: ZoneNode[],
  out: Set<string>,
  flag: { dynamic: boolean },
): void {
  for (const node of nodes) {
    if (node.form === 'element') {
      // `class` arrives as an element prop (modern `bind class, ...`) or an attribute (legacy `seed class, ...`)
      const carriers = [
        ...node.props.filter(p => p.name === 'class'),
        ...node.attributes.filter(a => a.name === 'class' && !a.event),
      ]

      for (const carrier of carriers) {
        if (carrier.value.form === 'string') {
          for (const token of carrier.value.value.split(/\s+/)) {
            if (token) {
              out.add(token)
            }
          }
        } else {
          // a dynamic class expression: the JIT cannot enumerate what it may produce
          flag.dynamic = true
        }
      }

      walk(node.children, out, flag)
    } else if (node.form === 'fork') {
      for (const branch of node.branches) {
        walk(branch.body, out, flag)
      }

      if (node.otherwise) {
        walk(node.otherwise, out, flag)
      }
    } else if (node.form === 'walk') {
      walk(node.body, out, flag)
    }
  }
}

// collect every statically-known utility class used by the program's zone components
export function collectUsedClasses(program: Program): UsedClasses {
  const out = new Set<string>()
  const flag = { dynamic: false }

  for (const node of program) {
    if (node.form === 'zone') {
      walk(node.body, out, flag)
    }
  }

  return { classes: [...out].sort(), dynamic: flag.dynamic }
}
