// The `view` role: the reader for the sandboxed document dialect a page or a guide is written in.
//
// Four statement heads reach this reader and not one of them declares anything the author wrote. `load` reaches
// the approved catalogs, `host` names a constant or a parameter the route fills, `find` names a query the host
// resolves before rendering, and `view` defines the document. `tree` and `fuse` never arrive: the expander
// removes them on the parse tree before any mill runs. What this reader will NOT build is as much the point as what
// it will: no computed local, no attribute or event handler, no unbounded loop. See note/project/term/view/.
//
// The reader, every check, the gate, the lowering and the query manifest are compile/view-document.tree, and what a
// caller hands them (the catalog's sets, the graph's templates, the gate's options) is made into what they read by
// compile/view-catalog-handed.tree (item term-self-host-001-0079). This face keeps the types callers hold.

import type { Node } from '@term/make/code/parser/tree'
import type { GroupNode, RootNode } from '@term/make/code/parser/narrow'
import type {
  Diagnostic,
  Span,
} from '@term/make/code/parser/diagnostic'
import type { Template } from '@term/make/code/compile/template'
import type { Program } from '@term/make/code/compile/node'
import type { ViewCatalog } from '@term/make/code/compile/view-catalog'
import type { ViewCaps } from '@term/make/code/compile/view-cap'
import * as port from '@term/make/code/compile/view-document'
import * as handed from '@term/make/code/compile/view-catalog-handed'

// One type per form in @term/base/code/view-file. A `span` rides along on everything an error can point at.
export type Road = { step: string[] }
export type Like = { name: string; arg: Like[] }
export type Take = { name: string; like?: Like; span: Span }
export type Bind = { term: string; bond: Seed; span: Span }
export type Seed =
  | { form: 'text'; value: string; span: Span }
  // `code <mark>`: a reference to a record by its mark, collected apart from a plain text
  | { form: 'code'; value: string; span: Span }
  | { form: 'mark'; value: number; span: Span }
  | { form: 'wave'; value: boolean; span: Span }
  | { form: 'read'; value: Road; span: Span }
  | { form: 'call'; value: SeedCall; span: Span }
// `made` is synthesized by the reader: a `walk size`'s range call skips the operator catalog
export type SeedCall = {
  name: string
  bind: Bind[]
  slot: Seed[]
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
export type ViewDef = {
  name: string
  take: Take[]
  node: ViewNode[]
  span: Span
}
export type ViewLoadFind = { name: string; alias?: string }
export type ViewLoad = {
  path: string
  find: ViewLoadFind[]
  span: Span
}
export type ViewHost = {
  name: string
  bond?: Seed
  like?: Like
  span: Span
}
export type ViewHold = {
  name: string
  bind: Bind[]
  slot: Seed[]
  span: Span
}
export type ViewMeet = {
  mode: string
  hold: ViewHold[]
  meet: ViewMeet[]
  span: Span
}
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

// A word the dialect refuses where a STATEMENT or a BODY NODE is expected, and what to say instead
export const VIEW_REFUSED_HEAD: Map<string, string> =
  handed.refusedHeadTable()

// The catalog is the four closed vocabularies: absent means no name is checked, which is what the grammar and
// lowering tests want. `lean` is the lean surface for a placement's inputs (ViewCheck.lean)
export function readView(
  tree: RootNode,
  file: string,
  catalog?: ViewCatalog,
  caps?: ViewCaps,
  lean?: boolean,
): ViewResult {
  return handed.readHandedView(tree as never, file, {
    catalog: catalog as never,
    caps,
    lean,
  }) as ViewResult
}

// ---- the one gate ----
// The compiler, `term view`, and a save path all call THIS, so the three cannot answer differently about what a
// document may say: parse, cycles BEFORE expansion, the fuses, the size the macros would build, then expand and read

export type ViewCheck = {
  catalog?: ViewCatalog
  caps?: ViewCaps
  // the already-parsed tree, when the caller has one
  tree?: RootNode
  // every template in the module graph, not only this file's own. See note/project/term/view/02-macro.md.
  templates?: Map<string, Template>
  // `mark lean` on the document's role rule: inside a placement, a plain-name child with a value is a `bind`
  lean?: boolean
}

export function checkView(
  source: { file: string; text: string },
  options: ViewCheck = {},
): ViewResult {
  return handed.checkHandedView(source, options as never) as ViewResult
}

// Every `fuse` names a macro something declares, against this file's macros and every one the graph brought in
export function viewFused(
  tree: RootNode,
  file: string,
  known: Iterable<string>,
): Diagnostic[] {
  return port.viewFused(tree as never, file, [...known])
}

// What the document will expand to, computed WITHOUT expanding it
export function viewBomb(
  tree: RootNode,
  file: string,
  known: Map<string, GroupNode>,
  cap: number,
): Diagnostic[] {
  return port.viewBomb(
    tree as never,
    file,
    known as unknown as Map<string, Node> as never,
    cap,
  )
}

// a macro that fuses itself, named, before expansion would crash on it
export function viewCycles(tree: RootNode, file: string): Diagnostic[] {
  return port.viewCycles(tree as never, file)
}

// A document becomes one `view` Statement per `view`. A `find` becomes a PARAMETER, never a fetch, and a `host`
// constant folds into the body at its use sites. See note/project/term/view/03-find.md and 07-lowering.md.
export function lowerView(file: ViewFile): Program {
  return port.lowerView(file as never) as unknown as Program
}

// What the host reads to resolve a document's queries, in the `host` dialect, written by the dialect's own writer
export function viewManifest(file: ViewFile, module: string): string {
  return port.viewManifest(file as never, module)
}
