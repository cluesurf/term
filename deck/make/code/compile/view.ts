// The `view` role: the reader for the sandboxed document dialect a page or a guide is written in.
//
// Four statement heads reach this reader and not one of them declares anything the author wrote. `load` reaches
// the approved catalogs, `host` names a constant or a parameter the route fills, `find` names a query the host
// resolves before rendering, and `view` defines the document. `tree` and `fuse` never arrive: the expander
// removes them on the parse tree before any mill runs.
//
// This produces the forms `@term/base/code/view-file` declares, and `deck/mill/code/tree/view/` is the grammar that
// says the same thing declaratively. The two are held against each other by test/compile/view-grammar.ts.
//
// The body reuses the component AST rather than restating it, so a document lowers through view-lower.ts and
// every backend emits it as an ordinary function. What this reader will NOT build is as much the point as what
// it will: no computed local, no attribute or event handler, no unbounded loop. See note/term/view/.
//
// The reader, every check, the gate (`checkView`), the lowering and the query manifest are compile/view-document.tree
// (self-hosting, 2026-10-06). This face keeps the types callers hold, turns a catalog's `Set`s and `Map`s into the
// lists and hashes the port reads in the same order, and hands the port a caller's templates the way
// compile/template.ts does.

import type { Node } from '@term/make/code/parser/tree'
import type { GroupNode, RootNode } from '@term/make/code/parser/narrow'
import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import type { Template } from '@term/make/code/compile/template'
import type { Program } from '@term/make/code/compile/node'
import type { ViewCatalog } from '@term/make/code/compile/view-catalog'
import type { ViewCaps } from '@term/make/code/compile/view-cap'
import { makeViewCaps } from '@term/make/code/compile/view-cap'
import * as port from '@term/make/code/compile/view-document'

// ---- the forms ----
// One per form in @term/base/code/view-file, plus the ones reused from zone, seed, bind, road, like and take.
// A `span` rides along on everything an error can point at.

export type Road = { step: string[] }
export type Like = { name: string; arg: Like[] }
export type Take = { name: string; like?: Like; span: Span }
export type Bind = { term: string; bond: Seed; span: Span }

export type Seed =
  | { form: 'text'; value: string; span: Span }
  // `code <mark>`: a reference to a record by its mark. Lowers to the mark as text, and is collected separately
  // from a plain text, because a reference is what delete protection and cache invalidation walk.
  | { form: 'code'; value: string; span: Span }
  | { form: 'mark'; value: number; span: Span }
  | { form: 'wave'; value: boolean; span: Span }
  | { form: 'read'; value: Road; span: Span }
  | { form: 'call'; value: SeedCall; span: Span }

export type SeedCall = {
  name: string
  bind: Bind[]
  slot: Seed[]
  // synthesized by the reader, never written by an author. `walk size` normalises into a walk over `range(...)`,
  // and that call must skip the operator catalog while an author's `call range` must not
  made?: true
}

export type ViewNode =
  | { form: 'view'; value: ViewUse; span: Span }
  | { form: 'text'; value: string; span: Span }
  | { form: 'walk'; value: ViewWalk; span: Span }
  | { form: 'fork'; value: ViewFork; span: Span }

export type ViewUse = { name: string; bind: Bind[]; node: ViewNode[] }
export type ViewWalk = { road: Seed; next: ViewWalkNext[] }
export type ViewWalkNext = { site?: string; node: ViewNode[] }
export type ViewFork = { hook: ViewForkHook[] }

export type ViewForkHook =
  | { form: 'test'; seed: Seed; span: Span }
  | { form: 'hold'; node: ViewNode[]; span: Span }
  | { form: 'miss'; node: ViewNode[]; span: Span }

export type ViewDef = { name: string; take: Take[]; node: ViewNode[]; span: Span }
export type ViewLoadFind = { name: string; alias?: string }
export type ViewLoad = { path: string; find: ViewLoadFind[]; span: Span }
export type ViewHost = { name: string; bond?: Seed; like?: Like; span: Span }
export type ViewHold = { name: string; bind: Bind[]; slot: Seed[]; span: Span }
export type ViewMeet = { mode: string; hold: ViewHold[]; meet: ViewMeet[]; span: Span }
export type ViewSort = { way: string; road: Road; span: Span }

export type ViewFind = {
  name: string
  task: string
  meet?: ViewMeet
  hold: ViewHold[]
  sort: ViewSort[]
  size?: number
  slot?: number
  span: Span
}

export type ViewFile = {
  load: ViewLoad[]
  host: ViewHost[]
  find: ViewFind[]
  view: ViewDef[]
}

export type ViewResult =
  | { ok: true; file: ViewFile; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] }

// A word the dialect refuses where a STATEMENT or a BODY NODE is expected, and what to say instead. The refusal is
// about position and not about the word: several are legal deeper in a file.
export const VIEW_REFUSED_HEAD = new Map<string, string>(port.viewRefusedHeads().map(one => [one.word, one.why]))

// ---- the boundary ----

function catalogToPort(catalog: ViewCatalog | undefined): port.Maybe<port.ViewCatalog> {
  if (!catalog) {
    return { form: 'none' }
  }

  const task = new Map<string, port.CatalogQuery>()

  for (const [name, query] of catalog.task) {
    const site = new Map<string, port.CatalogField>()

    for (const [field, shape] of query.site) {
      site.set(field, { hold: [...shape.hold], sort: shape.sort })
    }

    task.set(name, {
      name: query.name,
      back: query.back,
      size: query.size === undefined ? { form: 'none' } : { form: 'some', value: query.size },
      site,
    })
  }

  return {
    form: 'some',
    value: { view: [...catalog.view], call: [...catalog.call], load: [...catalog.load], task },
  }
}

type PortTemplate = port.TreeTemplate

// a caller's template as compile/template.ts hands one to the expander
function templateToPort(template: Template): PortTemplate {
  return {
    params: template.params,
    holes: (template.holes ?? new Map()) as PortTemplate['holes'],
    ...(template.sites ? { sites: [...template.sites] } : {}),
    body: template.body,
  } as PortTemplate
}

function result(read: port.ViewResult): ViewResult {
  return read.ok
    ? { ok: true, file: read.file as unknown as ViewFile, diagnostics: read.diagnostics }
    : { ok: false, diagnostics: read.diagnostics }
}

// ---- reading ----

export function readView(
  tree: RootNode,
  file: string,
  // The four closed vocabularies. Absent means no name is checked, which is what the grammar and lowering tests
  // want; a project supplies one and then every name a document says is checked against it.
  catalog?: ViewCatalog,
  caps: ViewCaps = makeViewCaps(),
  // the lean surface for a placement's inputs. See ViewCheck.lean
  lean = false,
): ViewResult {
  return result(port.readView(tree as never, file, catalogToPort(catalog), caps, lean))
}

// ---- the one gate ----
// The compiler, `term view`, and a save path all call THIS, so the three cannot answer differently about what a
// document may say. It is the whole path in order: parse, then cycles BEFORE expansion (expansion is what a cycle
// crashes), then the fuses, then the size the macros would build, then expand and read against the catalog and caps.

export type ViewCheck = {
  catalog?: ViewCatalog
  caps?: ViewCaps
  // the already-parsed tree, when the caller has one
  tree?: RootNode
  // every template in the module graph, not only this file's own. See note/term/view/02-macro.md.
  templates?: Map<string, Template>
  // `mark lean` on the document's role rule: inside a placement, a plain-name child with a value is a `bind`
  lean?: boolean
}

export function checkView(
  source: { file: string; text: string },
  options: ViewCheck = {},
): ViewResult {
  const templates = new Map<string, PortTemplate>()

  for (const [name, template] of options.templates ?? []) {
    templates.set(name, templateToPort(template))
  }

  return result(
    port.checkView(
      source,
      catalogToPort(options.catalog),
      options.caps ? { form: 'some', value: options.caps } : { form: 'none' },
      options.tree ? { form: 'some', value: options.tree as never } : { form: 'none' },
      templates,
      options.lean ?? false,
    ),
  )
}

// ---- macros, checked before expansion ----

// Every `fuse` names a macro something declares, against this file's macros and every one the graph brought in
export function viewFused(tree: RootNode, file: string, known: Iterable<string>): Diagnostic[] {
  return port.viewFused(tree as never, file, [...known])
}

// What the document will expand to, computed WITHOUT expanding it
export function viewBomb(tree: RootNode, file: string, known: Map<string, GroupNode>, cap: number): Diagnostic[] {
  return port.viewBomb(tree as never, file, known as unknown as Map<string, Node> as never, cap)
}

// a macro that fuses itself, named, before expansion would crash on it
export function viewCycles(tree: RootNode, file: string): Diagnostic[] {
  return port.viewCycles(tree as never, file)
}

// ---- lowering ----
// A document becomes one `view` Statement per `view`. A `find` becomes a PARAMETER, never a fetch, and a `host`
// constant folds into the body at its use sites. See note/term/view/03-find.md and 07-lowering.md.

export function lowerView(file: ViewFile): Program {
  return port.lowerView(file as never) as unknown as Program
}

// ---- the query manifest ----
// What the host reads to resolve a document's queries, in the `host` dialect, written by the dialect's own writer

export function viewManifest(file: ViewFile, module: string): string {
  return port.viewManifest(file as never, module)
}
