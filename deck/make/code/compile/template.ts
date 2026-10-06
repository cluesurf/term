// Template expansion for `tree` and `fuse` (compile-time macros), run on the parse tree (CST) before the mill. The pass
// is Term, compile/templates.tree (self-hosting, 2026-10-06), and its header says what a template can do. This face
// keeps the shape its TypeScript callers hold a template in: its sites are a `Set` here and a list in Term, in the order
// they were found. Browser-safe.

import type { Node } from '@term/make/code/parser/tree'
import type { RootNode } from '@term/make/code/parser/narrow'
import type { Span } from '@term/make/code/parser/diagnostic'
import * as port from '@term/make/code/compile/templates'

// what a hole holds, when its `take` says: `like number` a number literal, `like text` a text literal, `like boolean`
// `true` or `false`, `like name` one word. A hole with no `like` holds any one word or literal, as every hole did
export type HoleKind = 'number' | 'text' | 'boolean' | 'name'

// `holes` holds a `take` line's kind and its `fall` default where it wrote them; `sites` the `site <name>` places a
// `beam` fills. `params` is the holes' names in order, which a positional argument fills
export type Template = {
  params: string[]
  holes?: Map<string, { kind?: HoleKind; fallback?: Node }>
  sites?: Set<string>
  body: Node[]
}

// a `fuse` that does not fit its template: a hole left out, a value too many, a name the template does not take, a
// value of the wrong kind. Reported at the fuse, before anything of the expansion is read
export type TemplateProblem = { code: 'unknown-name' | 'unexpected-node' | 'type-mismatch'; message: string; span: Span }

type PortTemplate = ReturnType<typeof port.collectTemplates> extends Map<string, infer T> ? T : never

function toPort(template: Template): PortTemplate {
  return {
    params: template.params,
    holes: (template.holes ?? new Map()) as PortTemplate['holes'],
    ...(template.sites ? { sites: [...template.sites] } : {}),
    body: template.body,
  } as PortTemplate
}

function fromPort(template: PortTemplate): Template {
  return {
    params: template.params,
    holes: template.holes as Template['holes'],
    sites: new Set(template.sites ?? []),
    body: template.body,
  }
}

// extract the `tree` template definitions from a parse tree
export function collectTemplates(tree: RootNode): Map<string, Template> {
  return new Map([...port.collectTemplates(tree)].map(([name, template]) => [name, fromPort(template)]))
}

// extract `host <name> / term <a> / term <b> / ...` enumerations, so a meta-loop can iterate their items
export function collectEnumerations(tree: RootNode): Map<string, string[]> {
  return port.collectEnumerations(tree)
}

// expand all templates in a parse tree. `externalTemplates` / `externalEnums` carry definitions from other loaded
// modules, so a `fuse` (or a meta-loop) can use a template or enumeration an imported module defines. `problems`, when
// given, collects every fuse that does not fit its template (`TemplateProblem`)
export function expandTemplates(
  tree: RootNode,
  externalTemplates?: Map<string, Template>,
  externalEnums?: Map<string, string[]>,
  problems: TemplateProblem[] = [],
): RootNode {
  const templates = new Map([...(externalTemplates ?? [])].map(([name, template]) => [name, toPort(template)]))

  return port.expandTemplates(tree, templates, externalEnums ?? new Map(), problems)
}
