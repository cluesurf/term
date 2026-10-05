// The forms whose TAG the program reads as a field (`s/form`, or the name `mark tag, name kind` gives): the checker
// marks each such member read with `tag`, the form's name. TypeScript reads the field its values already carry. A
// native backend gives each of these forms one accessor, the case's name as text, and only these, so a program that
// never reads a tag carries none.
import type { Program } from '@term/make/code/compile/node'

// the names SORTED, the shape the port (compile/tag.tree) answers, so the order a walk meets them in cannot move
// Swift's accessors
export function taggedForms(program: Program): string[] {
  const forms = new Set<string>()
  const seen = new Set<object>()
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || seen.has(value)) {
      return
    }

    seen.add(value)

    if (Array.isArray(value)) {
      value.forEach(visit)

      return
    }

    const node = value as { form?: unknown; tag?: unknown }

    if (node.form === 'member' && typeof node.tag === 'string') {
      forms.add(node.tag)
    }

    for (const [key, inner] of Object.entries(value)) {
      if (key !== 'span' && key !== 'type') {
        visit(inner)
      }
    }
  }

  visit(program)

  return [...forms].sort()
}

// the text a case's tag reads as: its name as written, which is what TypeScript's values carry
export function tagText(caseName: string): string {
  return caseName
}
