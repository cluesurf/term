// The `view` role: the reader for the sandboxed document dialect a page or a guide is written in.
//
// Four statement heads reach this reader and not one of them declares anything the author wrote. `load` reaches
// the approved catalogs, `host` names a constant or a parameter the route fills, `find` names a query the host
// resolves before rendering, and `view` defines the document. `tree` and `fuse` never arrive: the expander
// removes them on the parse tree before any mill runs.
//
// This produces the forms `@term/seed/code/view-file` declares, and `deck/mill/code/view/` is the grammar that
// says the same thing declaratively. The two are held against each other by test/compile/view-grammar.ts, which
// is what keeps the grammar true while the mill executor is being built. When that executor lands this file is
// deleted and the gate becomes a differential. Same shape the `host` dialect used, for the same reason.
//
// The body reuses the component AST rather than restating it, so a document lowers through view-lower.ts and
// every backend emits it as an ordinary function. What this reader will NOT build is as much the point as what
// it will: no computed local, no attribute or event handler, no unbounded loop. See note/term/view/.

import type {
  GroupNode,
  NameNode,
  Node,
  RootNode,
  TextNode,
} from '@term/make/code/parser/tree'
import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import { parse } from '@term/make/code/parser/tree'
import {
  expandTemplates,
  collectTemplates,
} from '@term/make/code/compile/template'
import type { Template } from '@term/make/code/compile/template'
import type {
  Expression,
  Program,
  Statement,
  ViewNode as CompilerZoneNode,
} from '@term/make/code/compile/node'
import type { ViewCatalog } from '@term/make/code/compile/view-catalog'
import { writeLong } from '@term/make/code/compile/host'
import type { Data, DataEntry } from '@term/make/code/compile/host'
import type { ViewCaps } from '@term/make/code/compile/view-cap'
import { VIEW_CAPS, capMessage } from '@term/make/code/compile/view-cap'

// ---- the forms ----
// One per form in @term/seed/code/view-file, plus the ones reused from zone, seed, bind, road, like and take.
// A `span` rides along on everything an error can point at; the Term-side forms carry no such field, and the
// lowering is what needs it.

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
  // and that call must skip the operator catalog while an author's `call range` must not. Matching the NAME would
  // let anyone opt out of the catalog by picking it.
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

// A word the dialect refuses where a STATEMENT or a BODY NODE is expected, and what to say instead. Several of
// these are legal deeper in a file: `task` names a query inside a `find`, `hook` carries the body of a `walk`,
// `test` is the mode of a `fork`. So the refusal is about position and not about the word, which is why the gate
// checks it against the four statement heads rather than against the whole grammar.
//
// A grammar with no case for a word reports "unknown head", which is correct and useless to someone writing a
// document, so every one of these gets its own sentence.
export const VIEW_REFUSED_HEAD = new Map<string, string>([
  ['task', 'a document cannot declare a function. Use `call` to apply one from the operator catalog'],
  ['dock', 'a document cannot reach a native module'],
  ['save', 'a document cannot hold state. A value comes from a `host`, a `find`, or a `take`'],
  ['form', 'a document cannot declare a type'],
  ['hook', 'a `hook` belongs inside a `walk` or a `fork`, never at the top of a file'],
  ['test', 'a document cannot declare a test'],
  ['mask', 'a document cannot declare a trait'],
  ['bear', 'a document cannot re-export'],
  ['halt', 'a document cannot raise'],
  ['tree', 'a macro is expanded before this point, so a `tree` here means the expander did not run'],
  ['fuse', 'a macro is expanded before this point, so a `fuse` here means the expander did not run'],
  ['note', 'a document carries no metadata. `note async` and `note unsafe` have no meaning here, and a comment is `#`'],
  ['wait', 'nothing a document writes is asynchronous. Every query is resolved before rendering starts'],
  ['dock', 'a document cannot reach a native module'],
  ['roll', 'a document declares nothing for the hive'],
  ['tell', 'a document decides nothing about what a customer is told'],
  ['rule', 'a document declares no theorem'],
  ['line', 'a document is not a command'],
  ['seed', 'a document sets no attribute and no event handler. A component takes its values by `bind`'],
])

// The operators people reach for that no catalog should register, and the reason for each. A catalog could of
// course leave any operator out, and then the message is the ordinary one. These four get a sentence because
// they are the ones an author will assume are there.
const REFUSED_CALL = new Map<string, string>([
  ['random', 'it is not deterministic, so a document would render differently on the server and in the browser, and differently on two reads'],
  ['uuid', 'it is not deterministic, so a document would render differently on the server and in the browser, and differently on two reads'],
  ['now', 'it is not deterministic. The host passes the time in as a `host` parameter, which also makes a document testable'],
  ['resolve', 'it performs input and output, and a renderer does neither. That is what lets one compiled document run on a server and in a browser'],
  ['walk', 'iteration is the `walk` head, and two spellings of one thing drift apart'],
  ['loop', 'iteration is the `walk` head, and two spellings of one thing drift apart'],
  ['branch', 'branching is the `fork` head, and two spellings of one thing drift apart'],
  ['switch', 'branching is the `fork` head, and two spellings of one thing drift apart'],
  ['match', 'branching is the `fork` head, and two spellings of one thing drift apart'],
  ['pick', 'branching is the `fork` head, and two spellings of one thing drift apart'],
  ['attempt', 'it catches an error, and a document has nothing to catch'],
  ['parse-json', 'it turns text into a shape nothing typed'],
])

const SORT_WAY = new Set(['rise', 'fall'])
const MEET_MODE = new Set(['and', 'or', 'not'])

export function readView(
  tree: RootNode,
  file: string,
  // The four closed vocabularies. Absent means no name is checked, which is what the grammar and lowering tests
  // want; a project supplies one and then every name a document says is checked against it.
  catalog?: ViewCatalog,
  caps: ViewCaps = VIEW_CAPS,
): ViewResult {
  const diagnostics: Diagnostic[] = []

  const error = (span: Span, message: string): void => {
    diagnostics.push(diagnose('syntax-error', { file, span, message }))
  }

  const out: ViewFile = { load: [], host: [], find: [], view: [] }
  const names = new Map<string, string>()

  const claim = (name: string, kind: string, span: Span): void => {
    const held = names.get(name)

    if (held) {
      error(span, `"${name}" is already declared by a ${held}. A read has one answer, so a name is used once`)

      return
    }

    names.set(name, kind)
  }

  for (const group of tree.nodes) {
    if (group.kind !== 'group') {
      error(spanOf(group), 'a document is a list of statements')
      continue
    }

    const head = headOf(group)

    if (head && VIEW_REFUSED_HEAD.has(head)) {
      error(spanOf(group), `"${head}" is not part of a document: ${VIEW_REFUSED_HEAD.get(head)!}`)
      continue
    }

    switch (head) {
      case 'load': {
        const load = readLoad(group)

        if (load) {
          out.load.push(load)
        }

        break
      }
      case 'host': {
        const host = readHost(group)

        if (host) {
          claim(host.name, 'host', host.span)
          out.host.push(host)
        }

        break
      }
      case 'find': {
        const find = readFind(group)

        if (find) {
          claim(find.name, 'find', find.span)
          out.find.push(find)
        }

        break
      }
      case 'view': {
        const def = readDef(group)

        if (def) {
          claim(def.name, 'view', def.span)
          out.view.push(def)
        }

        break
      }
      default:
        error(
          spanOf(group),
          `"${head ?? '?'}" is not a statement of a document. A document has load, host, find and view, and nothing else`,
        )
    }
  }

  // ---- load ----

  function readLoad(group: GroupNode): ViewLoad | undefined {
    const span = spanOf(group)
    const path = keyOf(group)

    if (!path) {
      error(span, 'a `load` names a package: `load @view/text`')

      return undefined
    }

    if (path.startsWith('.') || path.startsWith('/')) {
      error(
        span,
        `"${path}" is a file path. A document loads a package from the approved catalog and never a file`,
      )

      return undefined
    }

    const find: ViewLoadFind[] = []

    for (const child of rest(group).slice(1)) {
      if (child.kind !== 'group') {
        continue
      }

      if (headOf(child) !== 'find') {
        error(spanOf(child), `a \`load\` holds \`find\` lines, never "${headOf(child) ?? '?'}"`)
        continue
      }

      const name = keyOf(child)

      if (!name) {
        error(spanOf(child), 'a `find` names what is taken: `find heading`')
        continue
      }

      const aliasNode = rest(child).find(n => n.kind === 'group' && headOf(n) === 'name')
      const alias = aliasNode?.kind === 'group' ? keyOf(aliasNode) : undefined

      find.push(alias ? { name, alias } : { name })
    }

    return { path, find, span }
  }

  // ---- host ----

  function readHost(group: GroupNode): ViewHost | undefined {
    const span = spanOf(group)
    const name = keyOf(group)

    if (!name) {
      error(span, 'a `host` names a value: `host title, text <Vowels>` or `host slug, like text`')

      return undefined
    }

    const parts = rest(group).slice(1)
    const likeNode = parts.find(
      (n): n is GroupNode => n.kind === 'group' && headOf(n) === 'like',
    )

    if (likeNode) {
      return { name, like: readLike(likeNode), span }
    }

    const valueNode = parts[0]

    if (!valueNode) {
      error(
        span,
        `"${name}" has no value and no type. A constant is \`host ${name}, <value>\`, a parameter is \`host ${name}, like <type>\``,
      )

      return undefined
    }

    const bond = readSeed(valueNode)

    return bond ? { name, bond, span } : undefined
  }

  function readLike(group: GroupNode): Like {
    return {
      name: keyOf(group) ?? '',
      arg: rest(group)
        .filter((n): n is GroupNode => n.kind === 'group' && headOf(n) === 'like')
        .map(readLike),
    }
  }

  // ---- find ----

  function readFind(group: GroupNode): ViewFind | undefined {
    const span = spanOf(group)
    const name = keyOf(group)

    if (!name) {
      error(span, 'a `find` names its result: `find vowel`')

      return undefined
    }

    let task: string | undefined
    let meet: ViewMeet | undefined
    let size: number | undefined
    let slot: number | undefined

    const hold: ViewHold[] = []
    const sort: ViewSort[] = []

    for (const child of rest(group).slice(1)) {
      if (child.kind !== 'group') {
        continue
      }

      const childHead = headOf(child)

      switch (childHead) {
        case 'task': {
          const value = textOf(child)

          if (value === undefined) {
            error(spanOf(child), 'a `task` names a catalog query as text: `task <filter:phoneme>`')
            break
          }

          if (task !== undefined) {
            error(spanOf(child), `"${name}" names a query twice`)
            break
          }

          task = value
          break
        }
        case 'meet': {
          const group2 = readMeet(child)

          if (group2) {
            if (meet) {
              error(spanOf(child), `"${name}" has two \`meet\` groups. Nest one inside the other`)
              break
            }

            meet = group2
          }

          break
        }
        case 'hold': {
          const one = readHold(child)

          if (one) {
            hold.push(one)
          }

          break
        }
        case 'sort': {
          const one = readSort(child)

          if (one) {
            sort.push(one)
          }

          break
        }
        case 'size':
        case 'slot': {
          const value = numberOf(child)

          if (value === undefined) {
            error(spanOf(child), `a \`${childHead}\` takes a whole number`)
            break
          }

          if (childHead === 'size') {
            size = value
          } else {
            slot = value
          }

          break
        }
        default:
          error(
            spanOf(child),
            `"${childHead ?? '?'}" is not part of a \`find\`. A find has task, meet, hold, sort, size and slot`,
          )
      }
    }

    if (task === undefined) {
      error(span, `"${name}" names no query. A find calls one: \`task <select:language>\``)

      return undefined
    }

    return { name, task, meet, hold, sort, size, slot, span }
  }

  function readMeet(group: GroupNode): ViewMeet | undefined {
    const span = spanOf(group)
    const mode = keyOf(group)

    if (!mode || !MEET_MODE.has(mode)) {
      error(span, `a \`meet\` is and, or, or not, never "${mode ?? '?'}"`)

      return undefined
    }

    const hold: ViewHold[] = []
    const meet: ViewMeet[] = []

    for (const child of rest(group).slice(1)) {
      if (child.kind !== 'group') {
        continue
      }

      if (headOf(child) === 'hold') {
        const one = readHold(child)

        if (one) {
          hold.push(one)
        }
      } else if (headOf(child) === 'meet') {
        const one = readMeet(child)

        if (one) {
          meet.push(one)
        }
      } else {
        error(spanOf(child), `a \`meet\` holds \`hold\` and \`meet\`, never "${headOf(child) ?? '?'}"`)
      }
    }

    if (mode === 'not' && hold.length + meet.length !== 1) {
      error(span, `a \`meet not\` takes exactly one child, and this one has ${hold.length + meet.length}`)
    }

    return { mode, hold, meet, span }
  }

  function readHold(group: GroupNode): ViewHold | undefined {
    const span = spanOf(group)
    const name = keyOf(group)

    if (!name) {
      error(span, 'a `hold` names a predicate: `hold is-equal`')

      return undefined
    }

    const { bind, slot } = readArguments(group, 'hold', name)

    return { name, bind, slot, span }
  }

  function readSort(group: GroupNode): ViewSort | undefined {
    const span = spanOf(group)
    const way = keyOf(group)

    if (!way || !SORT_WAY.has(way)) {
      error(span, `a \`sort\` is rise or fall, never "${way ?? '?'}"`)

      return undefined
    }

    const readNode = rest(group)
      .slice(1)
      .find((n): n is GroupNode => n.kind === 'group' && headOf(n) === 'read')

    if (!readNode) {
      error(span, 'a `sort` names its key: `sort fall, read self/frequency`')

      return undefined
    }

    return { way, road: roadOf(readNode), span }
  }

  // ---- the view definition and its body ----

  function readDef(group: GroupNode): ViewDef | undefined {
    const span = spanOf(group)
    const name = keyOf(group)

    if (!name) {
      error(span, 'a `view` names itself: `view page`')

      return undefined
    }

    const take: Take[] = []
    const node: ViewNode[] = []

    for (const child of rest(group).slice(1)) {
      if (child.kind !== 'group') {
        continue
      }

      if (headOf(child) === 'take') {
        const takeName = keyOf(child)

        if (!takeName) {
          error(spanOf(child), 'a `take` names a parameter: `take slug, like text`')
          continue
        }

        const likeNode = rest(child)
          .slice(1)
          .find((n): n is GroupNode => n.kind === 'group' && headOf(n) === 'like')

        const shadowed = names.get(takeName)

        if (shadowed) {
          error(
            spanOf(child),
            `"${takeName}" is already declared by a ${shadowed}, so a \`read ${takeName}\` would have two answers`,
          )
          continue
        }

        take.push({ name: takeName, like: likeNode ? readLike(likeNode) : undefined, span: spanOf(child) })
        continue
      }

      const one = readNode(child)

      if (one) {
        node.push(one)
      }
    }

    return { name, take, node, span }
  }

  function readNode(group: GroupNode): ViewNode | undefined {
    const span = spanOf(group)
    const head = headOf(group)

    if (head && VIEW_REFUSED_HEAD.has(head)) {
      error(span, `"${head}" is not part of a document: ${VIEW_REFUSED_HEAD.get(head)!}`)

      return undefined
    }

    switch (head) {
      case 'view': {
        const name = keyOf(group)

        if (!name) {
          error(span, 'a `view` in a body names a component: `view text/heading`')

          return undefined
        }

        const bind: Bind[] = []
        const node: ViewNode[] = []

        for (const child of rest(group).slice(1)) {
          if (child.kind !== 'group') {
            continue
          }

          if (headOf(child) === 'bind') {
            const one = readBind(child)

            if (one) {
              bind.push(one)
            }

            continue
          }

          if (headOf(child) === 'seed') {
            error(
              spanOf(child),
              'a document cannot set an attribute or an event handler. A component takes its values by `bind`',
            )
            continue
          }

          const one = readNode(child)

          if (one) {
            node.push(one)
          }
        }

        return { form: 'view', value: { name, bind, node }, span }
      }
      case 'text': {
        const value = textOf(group)

        if (value === undefined) {
          error(span, 'a `text` node holds text: `text <Vowels>`')

          return undefined
        }

        return { form: 'text', value, span }
      }
      case 'walk':
        return readWalk(group)
      case 'fork':
        return readFork(group)
      default:
        error(
          span,
          `"${head ?? '?'}" is not part of a document body. A body has view, text, walk and fork`,
        )

        return undefined
    }
  }

  function readWalk(group: GroupNode): ViewNode | undefined {
    const span = spanOf(group)
    const mode = keyOf(group)

    if (mode === 'test') {
      error(
        span,
        'a `walk test` has no end of its own, so a document cannot use one. `walk list` ends at the list and `walk size` at its bound',
      )

      return undefined
    }

    // `walk size` is normalised here into a `walk list` over `range(base, head)`, so nothing downstream learns
    // there are two kinds of walk. The zone AST carries only a list walk, and `range` is a render-runtime task.
    // Written this way rather than as a counted node because adding one would touch every pass that reads a walk.
    if (mode === 'size') {
      const parts = rest(group)
        .slice(1)
        .filter((n): n is GroupNode => n.kind === 'group')

      const bound = (word: string): Seed | undefined => {
        const found = parts.find(n => headOf(n) === 'bind' && keyOf(n) === word)
        const value = found ? rest(found).slice(1)[0] : undefined

        return value ? readSeed(value) : undefined
      }

      // `walk size, read total` is the short form, counting from zero
      const short = rest(group)
        .slice(1)
        .find(n => n.kind === 'group' && headOf(n) !== 'bind' && headOf(n) !== 'hook')

      const base = bound('base') ?? { form: 'mark' as const, value: 0, span }
      const head =
        bound('head') ?? (short?.kind === 'group' ? readSeed(short) : undefined)

      if (!head) {
        error(
          span,
          'a `walk size` names how far it counts: `walk size / bind base, 0 / bind head, 100`, or `walk size, read total`',
        )

        return undefined
      }

      return {
        form: 'walk',
        value: {
          road: {
            form: 'call',
            value: { name: 'range', bind: [], slot: [base, head], made: true },
            span,
          },
          next: readWalkNext(group),
        },
        span,
      }
    }

    if (mode !== 'list') {
      error(span, `a \`walk\` is list or size, never "${mode ?? '?'}"`)

      return undefined
    }

    const roadNode = rest(group)
      .slice(1)
      .find((n): n is GroupNode => n.kind === 'group' && headOf(n) !== 'hook')

    if (!roadNode) {
      error(span, 'a `walk list` names what it walks: `walk list, read vowel`')

      return undefined
    }

    const road = readSeed(roadNode)

    if (!road) {
      return undefined
    }

    return { form: 'walk', value: { road, next: readWalkNext(group) }, span }
  }

  function readWalkNext(group: GroupNode): ViewWalkNext[] {
    const next: ViewWalkNext[] = []

    for (const child of rest(group)) {
      if (child.kind !== 'group' || headOf(child) !== 'hook') {
        continue
      }

      if (keyOf(child) !== 'next') {
        error(spanOf(child), `a \`walk\` holds \`hook next\`, never "hook ${keyOf(child) ?? '?'}"`)
        continue
      }

      let site: string | undefined
      const node: ViewNode[] = []

      for (const inner of rest(child).slice(1)) {
        if (inner.kind !== 'group') {
          continue
        }

        if (headOf(inner) === 'take') {
          const nameNode = rest(inner).find(
            (n): n is GroupNode => n.kind === 'group' && headOf(n) === 'name',
          )

          site = nameNode ? keyOf(nameNode) : keyOf(inner)
          continue
        }

        const one = readNode(inner)

        if (one) {
          node.push(one)
        }
      }

      next.push({ site, node })
    }

    return next
  }

  function readFork(group: GroupNode): ViewNode | undefined {
    const span = spanOf(group)
    const mode = keyOf(group)

    if (mode === 'case') {
      error(
        span,
        'a `fork case` matches the variants of a form, and a document declares none. Use `fork test`',
      )

      return undefined
    }

    if (mode !== 'test') {
      error(span, `a \`fork\` is test, never "${mode ?? '?'}"`)

      return undefined
    }

    const hook: ViewForkHook[] = []

    for (const child of rest(group).slice(1)) {
      if (child.kind !== 'group' || headOf(child) !== 'hook') {
        error(spanOf(child), 'a `fork` holds `hook test`, `hook hold` and `hook miss`')
        continue
      }

      const kind = keyOf(child)
      const inner = rest(child)
        .slice(1)
        .filter((n): n is GroupNode => n.kind === 'group')

      if (kind === 'test') {
        const first = inner[0]
        const seed = first ? readSeed(first) : undefined

        if (!seed) {
          error(spanOf(child), 'a `hook test` names the value it branches on')
          continue
        }

        hook.push({ form: 'test', seed, span: spanOf(child) })
        continue
      }

      if (kind === 'hold' || kind === 'miss') {
        const node: ViewNode[] = []

        for (const one of inner) {
          const built = readNode(one)

          if (built) {
            node.push(built)
          }
        }

        hook.push({ form: kind, node, span: spanOf(child) })
        continue
      }

      error(spanOf(child), `a \`fork\` holds hook test, hook hold and hook miss, never "hook ${kind ?? '?'}"`)
    }

    return { form: 'fork', value: { hook }, span }
  }

  // ---- values ----

  function readBind(group: GroupNode): Bind | undefined {
    const span = spanOf(group)
    const term = keyOf(group)

    if (!term) {
      error(span, 'a `bind` names what it sets: `bind text, read title`')

      return undefined
    }

    const valueNode = rest(group).slice(1)[0]

    if (!valueNode) {
      error(span, `"${term}" is bound to nothing`)

      return undefined
    }

    const bond = readSeed(valueNode)

    return bond ? { term, bond, span } : undefined
  }

  function readArguments(
    group: GroupNode,
    what: string,
    name: string,
  ): { bind: Bind[]; slot: Seed[] } {
    const bind: Bind[] = []
    const slot: Seed[] = []

    for (const child of rest(group).slice(1)) {
      if (child.kind !== 'group') {
        continue
      }

      if (headOf(child) === 'bind') {
        const one = readBind(child)

        if (one) {
          bind.push(one)
        }

        continue
      }

      const one = readSeed(child)

      if (one) {
        slot.push(one)
      }
    }

    if (bind.length > 0 && slot.length > 0) {
      error(
        spanOf(group),
        `"${name}" mixes positional and named arguments in one ${what}. Use one spelling or the other`,
      )
    }

    return { bind, slot }
  }

  function readSeed(node: Node): Seed | undefined {
    const span = spanOf(node)

    if (node.kind === 'integer' || node.kind === 'radix') {
      return { form: 'mark', value: node.value, span }
    }

    if (node.kind === 'decimal') {
      return { form: 'mark', value: node.value, span }
    }

    if (node.kind === 'text') {
      return { form: 'text', value: literalText(node), span }
    }

    if (node.kind !== 'group') {
      error(span, 'a value is text, a number, true, false, a `read`, or a `call`')

      return undefined
    }

    const head = headOf(node)

    switch (head) {
      case 'text': {
        const value = textOf(node)

        return value === undefined
          ? (error(span, 'a `text` holds text: `text <vowel>`'), undefined)
          : { form: 'text', value, span }
      }
      case 'code': {
        // `code <quenya>` is a record reference by mark, `code 20` is a number. One head, told apart by the literal.
        const mark = textOf(node)

        if (mark !== undefined) {
          return { form: 'code', value: mark, span }
        }

        const value = numberOf(node)

        return value === undefined
          ? (error(span, 'a `code` holds a number (`code 20`) or a record mark (`code <quenya>`)'), undefined)
          : { form: 'mark', value, span }
      }
      case 'true':
        return { form: 'wave', value: true, span }
      case 'false':
        return { form: 'wave', value: false, span }
      case 'read':
        return { form: 'read', value: roadOf(node), span }
      case 'call': {
        const name = keyOf(node)

        if (!name) {
          error(span, 'a `call` names an operator: `call titlecase`')

          return undefined
        }

        const { bind, slot } = readArguments(node, 'call', name)

        return { form: 'call', value: { name, bind, slot }, span }
      }
      default: {
        const bare = numberOf(node)

        if (bare !== undefined) {
          return { form: 'mark', value: bare, span }
        }

        error(
          span,
          `"${head ?? '?'}" is not a value. A value is text, a number, true, false, a \`read\`, or a \`call\``,
        )

        return undefined
      }
    }
  }

  function roadOf(group: GroupNode): Road {
    const path = keyOf(group) ?? ''

    return { step: path.split('/').filter(step => step.length > 0) }
  }

  // ---- every bound has a number ----
  // Measured on the EXPANDED document, because that is what a browser builds. The tree arrives here already
  // expanded: `compile/template.ts` runs before any reader. See note/term/view/05-sandbox.md.

  const span0 = out.view[0]?.span ?? out.find[0]?.span ?? out.host[0]?.span

  const over = (cap: keyof ViewCaps, said: number): void => {
    if (said > caps[cap] && span0) {
      error(span0, capMessage(cap, said, caps))
    }
  }

  over('find', out.find.length)
  over('host', out.host.length)
  over('view', out.view.length)

  let nodeSum = 0
  let deepest = 0
  let callSum = 0

  const seedDepth = (seed: Seed, depth: number): void => {
    if (seed.form !== 'call') {
      return
    }

    callSum++

    if (depth > caps.callDeep) {
      error(seed.span, capMessage('callDeep', depth, caps))

      return
    }

    for (const one of [...seed.value.slot, ...seed.value.bind.map(b => b.bond)]) {
      seedDepth(one, depth + 1)
    }
  }

  // `walks` is the chain of enclosing walk bounds, so the product is the number of nodes the innermost body can
  // build. A counted walk knows its own bound; a list walk does not, so it counts as the iteration cap.
  const measure = (nodes: ViewNode[], depth: number, walks: number[]): void => {
    deepest = Math.max(deepest, depth)

    if (depth > caps.deep) {
      const at = nodes[0]?.span

      if (at) {
        error(at, capMessage('deep', depth, caps))
      }

      return
    }

    for (const node of nodes) {
      nodeSum++

      switch (node.form) {
        case 'view':
          for (const bind of node.value.bind) {
            seedDepth(bind.bond, 1)
          }

          measure(node.value.node, depth + 1, walks)
          break
        case 'walk': {
          seedDepth(node.value.road, 1)

          const bound = countedBound(node.value.road, caps)
          const inner = [...walks, bound]

          if (inner.length > caps.walkDeep) {
            error(node.span, capMessage('walkDeep', inner.length, caps))
            break
          }

          const product = inner.reduce((a, b) => a * b, 1)

          if (product > caps.walkSum) {
            error(node.span, capMessage('walkSum', product, caps))
            break
          }

          for (const next of node.value.next) {
            measure(next.node, depth + 1, inner)
          }

          break
        }
        case 'fork':
          for (const hook of node.value.hook) {
            if (hook.form === 'test') {
              seedDepth(hook.seed, 1)
            } else {
              measure(hook.node, depth + 1, walks)
            }
          }

          break
        default:
          break
      }
    }
  }

  for (const def of out.view) {
    measure(def.node, 1, [])
  }

  over('node', nodeSum)
  over('callSum', callSum)

  // ---- the four closed vocabularies ----
  // Checked here rather than at each site, so one walk answers for the whole file and the messages come out in
  // file order. A name outside a catalog fails the compile, and the same registry answers for the save path and
  // the editor. See note/term/view/04-catalog.md.

  if (catalog) {
    for (const load of out.load) {
      if (!catalog.load.has(load.path)) {
        error(
          load.span,
          `"${load.path}" is not a package this document may load. ${near(load.path, catalog.load)}`,
        )
      }
    }

    for (const find of out.find) {
      const query = catalog.task.get(find.task)

      if (!query) {
        error(
          find.span,
          `"${find.task}" is not a registered query. ${near(find.task, new Set(catalog.task.keys()))}`,
        )

        continue
      }

      if (query.size !== undefined && find.size !== undefined && find.size > query.size) {
        error(
          find.span,
          `"${find.name}" asks for ${find.size} and "${find.task}" caps at ${query.size}`,
        )
      }

      // a predicate the resolver cannot push down to an index is a full table read wearing the costume of a
      // filter, so the catalog says per field which ones it can answer
      const holdOf = (hold: ViewHold): void => {
        const first = [...hold.slot, ...hold.bind.map(one => one.bond)][0]
        const road = first?.form === 'read' ? first.value.step : []

        if (road[0] !== 'self' || road.length < 2) {
          return
        }

        const field = road.slice(1).join('/')
        const known = query.site.get(field)

        if (!known) {
          error(
            hold.span,
            `"${find.task}" has no filterable field "${field}". ${near(field, new Set(query.site.keys()))}`,
          )

          return
        }

        if (!known.hold.has(hold.name)) {
          error(
            hold.span,
            `"${field}" does not accept "${hold.name}", because no index answers it. It accepts ${[...known.hold].sort().join(', ') || 'nothing'}`,
          )
        }
      }

      const meetOf = (meet: ViewMeet): void => {
        for (const hold of meet.hold) {
          holdOf(hold)
        }

        for (const inner of meet.meet) {
          meetOf(inner)
        }
      }

      for (const hold of find.hold) {
        holdOf(hold)
      }

      if (find.meet) {
        meetOf(find.meet)
      }

      for (const sort of find.sort) {
        const field = sort.road.step.slice(1).join('/')
        const known = query.site.get(field)

        if (!known?.sort) {
          error(
            sort.span,
            `"${find.task}" does not sort on "${field}", because no ordered index answers it`,
          )
        }
      }
    }

    const seenCalls = (seed: Seed): void => {
      if (seed.form === 'call') {
        // `range` is the render runtime's, synthesized for a counted walk, never written by an author
        // the always-refused set is handled above, catalog or not. Here is only "is it registered".
        if (!seed.value.made && !REFUSED_CALL.has(seed.value.name) && !catalog.call.has(seed.value.name)) {

          error(
            seed.span,
            `"${seed.value.name}" is not a registered operator. ${near(seed.value.name, catalog.call)}`,
          )
        }

        for (const one of [...seed.value.slot, ...seed.value.bind.map(b => b.bond)]) {
          seenCalls(one)
        }
      }
    }

    const seenNodes = (nodes: ViewNode[]): void => {
      for (const node of nodes) {
        switch (node.form) {
          case 'view':
            if (!catalog.view.has(node.value.name)) {
              error(
                node.span,
                `"${node.value.name}" is not a component this document may place. ${near(node.value.name, catalog.view)}`,
              )
            }

            for (const bind of node.value.bind) {
              seenCalls(bind.bond)
            }

            seenNodes(node.value.node)
            break
          case 'walk':
            seenCalls(node.value.road)

            for (const next of node.value.next) {
              seenNodes(next.node)
            }

            break
          case 'fork':
            for (const hook of node.value.hook) {
              if (hook.form === 'test') {
                seenCalls(hook.seed)
              } else {
                seenNodes(hook.node)
              }
            }

            break
          default:
            break
        }
      }
    }

    for (const def of out.view) {
      seenNodes(def.node)
    }

    for (const host of out.host) {
      if (host.bond) {
        seenCalls(host.bond)
      }
    }

    for (const find of out.find) {
      for (const hold of find.hold) {
        for (const one of [...hold.slot, ...hold.bind.map(b => b.bond)]) {
          seenCalls(one)
        }
      }
    }
  }

  // ---- the operators no catalog may register ----
  // Run whether or not a catalog is given, because determinism and purity are properties of the RENDERING MODEL
  // and not of a project's taste. A document that renders differently on the server and in the browser breaks
  // server rendering; one that renders differently on two reads breaks the content-addressed cache; one that
  // performs input or output cannot run in both places at all.

  const alwaysRefused = (seed: Seed): void => {
    if (seed.form !== 'call') {
      return
    }

    const why = seed.value.made ? undefined : REFUSED_CALL.get(seed.value.name)

    if (why) {
      error(
        seed.span,
        `"${seed.value.name}" is not an operator a document may apply: ${why}`,
      )
    }

    for (const one of [...seed.value.slot, ...seed.value.bind.map(b => b.bond)]) {
      alwaysRefused(one)
    }
  }

  const everySeed = (nodes: ViewNode[], take: (seed: Seed) => void): void => {
    for (const node of nodes) {
      switch (node.form) {
        case 'view':
          for (const bind of node.value.bind) {
            take(bind.bond)
          }

          everySeed(node.value.node, take)
          break
        case 'walk':
          take(node.value.road)

          for (const next of node.value.next) {
            everySeed(next.node, take)
          }

          break
        case 'fork':
          for (const hook of node.value.hook) {
            if (hook.form === 'test') {
              take(hook.seed)
            } else {
              everySeed(hook.node, take)
            }
          }

          break
        default:
          break
      }
    }
  }

  for (const def of out.view) {
    everySeed(def.node, alwaysRefused)
  }

  for (const host of out.host) {
    if (host.bond) {
      alwaysRefused(host.bond)
    }
  }

  for (const find of out.find) {
    const holdSeeds = (hold: ViewHold): void => {
      for (const one of [...hold.slot, ...hold.bind.map(b => b.bond)]) {
        alwaysRefused(one)
      }
    }

    for (const hold of find.hold) {
      holdSeeds(hold)
    }

    const meetSeeds = (meet: ViewMeet): void => {
      for (const hold of meet.hold) {
        holdSeeds(hold)
      }

      for (const inner of meet.meet) {
        meetSeeds(inner)
      }
    }

    if (find.meet) {
      meetSeeds(find.meet)
    }
  }

  // ---- every read resolves ----
  // Run after the whole file is read, because a `host` may be declared below the `find` that reads it.
  //
  // Inside a `find` the scope is `self`, the record under test, plus the file's `host` names and NOTHING else. A
  // filter that reads another query's result is a join the author wrote, and the resolver has no place to put
  // one. A filter that reads a `take` is worse: a query resolves before any component is built, so the value
  // does not exist yet. See note/term/view/03-find.md.

  const hostNames = new Set(out.host.map(host => host.name))
  const findNames = new Set(out.find.map(find => find.name))

  const checkFindSeed = (seed: Seed, find: string): void => {
    if (seed.form === 'read') {
      const head = seed.value.step[0] ?? ''

      if (head === 'self') {
        return
      }

      if (findNames.has(head)) {
        error(
          seed.span,
          `"${find}" filters on the result of "${head}". A filter that reads another query is a join, and a query is resolved before any other runs`,
        )

        return
      }

      if (!hostNames.has(head)) {
        error(
          seed.span,
          `"${head}" is not in scope in a filter. A filter reads \`self\` for the record under test, or a \`host\`, and nothing else`,
        )
      }

      return
    }

    if (seed.form === 'call') {
      for (const one of seed.value.slot) {
        checkFindSeed(one, find)
      }

      for (const one of seed.value.bind) {
        checkFindSeed(one.bond, find)
      }
    }
  }

  const checkMeet = (meet: ViewMeet, find: string): void => {
    for (const hold of meet.hold) {
      checkHold(hold, find)
    }

    for (const inner of meet.meet) {
      checkMeet(inner, find)
    }
  }

  const checkHold = (hold: ViewHold, find: string): void => {
    for (const one of hold.slot) {
      checkFindSeed(one, find)
    }

    for (const one of hold.bind) {
      checkFindSeed(one.bond, find)
    }
  }

  for (const find of out.find) {
    for (const hold of find.hold) {
      checkHold(hold, find.name)
    }

    if (find.meet) {
      checkMeet(find.meet, find.name)
    }

    for (const sort of find.sort) {
      if ((sort.road.step[0] ?? '') !== 'self') {
        error(sort.span, `"${find.name}" sorts on "${sort.road.step.join('/')}". A sort key is a field of \`self\``)
      }
    }
  }

  // In a body the scope is the view's own parameters, the file's constants and query results, and the item of
  // every enclosing `walk`. `self` means nothing here, because there is no record under test.

  const checkBodySeed = (seed: Seed, scope: Set<string>, view: string): void => {
    if (seed.form === 'read') {
      const head = seed.value.step[0] ?? ''

      if (!scope.has(head)) {
        error(
          seed.span,
          head === 'self'
            ? `"${view}" reads \`self\`, which names the record under test inside a filter and nothing in a body`
            : `"${head}" is not in scope in "${view}". A body reads a take, a host, a find, or the item of a walk it is inside`,
        )
      }

      return
    }

    if (seed.form === 'call') {
      for (const one of seed.value.slot) {
        checkBodySeed(one, scope, view)
      }

      for (const one of seed.value.bind) {
        checkBodySeed(one.bond, scope, view)
      }
    }
  }

  const checkBody = (nodes: ViewNode[], scope: Set<string>, view: string): void => {
    for (const node of nodes) {
      switch (node.form) {
        case 'view':
          for (const bind of node.value.bind) {
            checkBodySeed(bind.bond, scope, view)
          }

          checkBody(node.value.node, scope, view)
          break
        case 'walk': {
          checkBodySeed(node.value.road, scope, view)

          for (const next of node.value.next) {
            const inner = new Set(scope)

            if (next.site) {
              inner.add(next.site)
            }

            checkBody(next.node, inner, view)
          }

          break
        }
        case 'fork':
          for (const hook of node.value.hook) {
            if (hook.form === 'test') {
              checkBodySeed(hook.seed, scope, view)
            } else {
              checkBody(hook.node, scope, view)
            }
          }

          break
        default:
          break
      }
    }
  }

  // A view that places itself never finishes rendering. Detected over the read forms rather than the parse tree,
  // because by here a component use and a view definition are told apart.
  const placed = new Map<string, Set<string>>()

  const places = (nodes: ViewNode[], into: Set<string>): Set<string> => {
    for (const node of nodes) {
      switch (node.form) {
        case 'view':
          into.add(node.value.name)
          places(node.value.node, into)
          break
        case 'walk':
          for (const next of node.value.next) {
            places(next.node, into)
          }

          break
        case 'fork':
          for (const hook of node.value.hook) {
            if (hook.form !== 'test') {
              places(hook.node, into)
            }
          }

          break
        default:
          break
      }
    }

    return into
  }

  for (const def of out.view) {
    placed.set(def.name, places(def.node, new Set()))
  }

  for (const def of out.view) {
    const ring = ringFrom(def.name, placed)

    if (ring) {
      error(def.span, `a view cannot place itself, and this one does: ${ring}`)
    }
  }

  for (const def of out.view) {
    const scope = new Set<string>([
      ...def.take.map(take => take.name),
      ...hostNames,
      ...findNames,
    ])

    checkBody(def.node, scope, def.name)
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics }
  }

  return { ok: true, file: out, diagnostics }
}

// The cycle a view is in, named, or nothing. Depth first over the places-graph, which is small.
function ringFrom(start: string, graph: Map<string, Set<string>>): string | undefined {
  const walk = (name: string, path: string[], seen: Set<string>): string | undefined => {
    if (seen.has(name)) {
      const at = path.indexOf(name)

      return [...path.slice(at === -1 ? 0 : at), name].join(' places ')
    }

    const next = graph.get(name)

    if (!next) {
      return undefined
    }

    seen.add(name)

    for (const one of next) {
      const found = walk(one, [...path, name], seen)

      if (found) {
        return found
      }
    }

    seen.delete(name)

    return undefined
  }

  return walk(start, [], new Set())
}

// The bound of a counted walk when it is a literal range, so nested walks can be multiplied out. A list walk, or
// a range whose bounds are read at run time, counts as the iteration cap instead.
function countedBound(road: Seed, caps: ViewCaps): number {
  if (road.form === 'call' && road.value.name === 'range') {
    const [base, head] = road.value.slot

    if (base?.form === 'mark' && head?.form === 'mark') {
      return Math.max(0, head.value - base.value)
    }
  }

  // a list walk, or a range read at run time: its length is not known until the query resolves, so it counts as
  // the assumed width. The number lives in the cap module with every other bound.
  return caps.walkWide
}

// The nearest registered name, so a typo says what was probably meant instead of only what was wrong. Plain edit
// distance over a small closed list, which is what these always are.
function near(said: string, known: Set<string>): string {
  let best: string | undefined
  let cost = Math.max(2, Math.floor(said.length / 3))

  for (const one of known) {
    const far = distance(said, one)

    if (far <= cost) {
      cost = far
      best = one
    }
  }

  if (best) {
    return `Did you mean "${best}"?`
  }

  return known.size === 0
    ? 'The catalog registers none.'
    : `The catalog registers ${known.size}.`
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)

  for (let i = 1; i <= a.length; i++) {
    let last = row[0]!
    row[0] = i

    for (let j = 1; j <= b.length; j++) {
      const keep = row[j]!
      row[j] = Math.min(
        row[j]! + 1,
        row[j - 1]! + 1,
        last + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      last = keep
    }
  }

  return row[b.length]!
}

// ---- the one gate ----
// The compiler, `term view`, and a save path all call THIS, so the three cannot answer differently about what a
// document may say. A second copy of a check is a second answer, and the two disagree eventually.
//
// It is the whole path in order: parse, then cycles BEFORE expansion (expansion is what a cycle crashes), then
// expand, then read against the catalog and the caps. Skipping a stage would prove less than a save does.

export type ViewCheck = {
  catalog?: ViewCatalog
  caps?: ViewCaps
  // the already-parsed tree, when the caller has one. The build has: `millUnit` parses every module before it
  // knows the role, and parsing again here doubled the cost of every document.
  tree?: RootNode
  // every template in the module graph, not only this file's own. A macro published by a repository or a package
  // is imported with `load`, so a document that fuses one gets it from here. Without it the `fuse` expands to
  // nothing and the document silently renders less than it says. See note/term/view/02-macro.md.
  templates?: Map<string, Template>
}

export function checkView(
  source: { file: string; text: string },
  options: ViewCheck = {},
): ViewResult {
  let tree = options.tree

  if (!tree) {
    const parsed = parse(source)

    if (!parsed.ok) {
      return { ok: false, diagnostics: parsed.diagnostics }
    }

    tree = parsed.tree
  }

  const rings = viewCycles(tree, source.file)

  if (rings.length > 0) {
    return { ok: false, diagnostics: rings }
  }

  // this file's macros, plus every one the module graph brought in
  const templates = new Map(options.templates ?? [])

  for (const [name, template] of collectTemplates(tree)) {
    templates.set(name, template)
  }

  const missing = viewFused(tree, source.file, templates.keys())

  if (missing.length > 0) {
    return { ok: false, diagnostics: missing }
  }

  return readView(
    expandTemplates(tree, templates),
    source.file,
    options.catalog,
    options.caps,
  )
}

// ---- macro cycles ----
// Run BEFORE expansion, because expansion is what a cycle destroys: `compile/template.ts` recurses on a `fuse`
// and a macro that fuses itself takes the stack down with it. A crash is not a diagnostic, and an author who can
// crash the compiler by writing two lines is a bound that does not hold.
//
// Walks the parse tree rather than the read forms, because by the time a `view-file` exists the macros are gone.

// Every `fuse` names a macro something declares. A fuse of a name nothing declares expands to NOTHING and the
// document compiles: it says "put a row here" and renders an empty page, with no diagnostic anywhere. That is
// the worst shape a defect can take in a document format, so it is a refusal.
//
// Checked before expansion, against this file's macros plus every one the module graph brought in, because a
// repository publishes macros and a document fuses them across a `load`.
export function viewFused(
  tree: RootNode,
  file: string,
  known: Iterable<string>,
): Diagnostic[] {
  const have = new Set(known)

  for (const node of tree.nodes) {
    if (node.kind === 'group' && headOf(node) === 'tree') {
      const name = keyOf(node)

      if (name) {
        have.add(name)
      }
    }
  }

  const diagnostics: Diagnostic[] = []

  const walk = (group: GroupNode): void => {
    for (const node of group.nodes) {
      if (node.kind !== 'group') {
        continue
      }

      if (headOf(node) === 'fuse') {
        const name = keyOf(node)

        if (name && !have.has(name)) {
          diagnostics.push(
            diagnose('syntax-error', {
              file,
              span: spanOf(node),
              message: `"${name}" is not a macro this document can reach. ${near(name, have)}`,
            }),
          )
        }
      }

      walk(node)
    }
  }

  for (const node of tree.nodes) {
    if (node.kind === 'group') {
      walk(node)
    }
  }

  return diagnostics
}

export function viewCycles(tree: RootNode, file: string): Diagnostic[] {
  const body = new Map<string, GroupNode>()

  for (const node of tree.nodes) {
    if (node.kind === 'group' && headOf(node) === 'tree') {
      const name = keyOf(node)

      if (name) {
        body.set(name, node)
      }
    }
  }

  const fused = (group: GroupNode, into: Set<string> = new Set()): Set<string> => {
    for (const node of group.nodes) {
      if (node.kind !== 'group') {
        continue
      }

      if (headOf(node) === 'fuse') {
        const name = keyOf(node)

        if (name) {
          into.add(name)
        }
      }

      fused(node, into)
    }

    return into
  }

  const edges = new Map<string, Set<string>>()

  for (const [name, group] of body) {
    edges.set(name, fused(group))
  }

  const diagnostics: Diagnostic[] = []
  const said = new Set<string>()

  // depth-first, keeping the path, so the message can name the cycle rather than only that there is one
  const walk = (name: string, path: string[], seen: Set<string>): void => {
    if (seen.has(name)) {
      const at = path.indexOf(name)
      const ring = [...path.slice(at === -1 ? 0 : at), name].join(' fuses ')

      if (!said.has(ring)) {
        said.add(ring)

        const group = body.get(path[0] ?? name)

        diagnostics.push(
          diagnose('syntax-error', {
            file,
            span: group ? spanOf(group) : ZERO,
            message: `a macro cannot fuse itself, and this one does: ${ring}`,
          }),
        )
      }

      return
    }

    const next = edges.get(name)

    if (!next) {
      return
    }

    seen.add(name)

    for (const one of next) {
      walk(one, [...path, name], seen)
    }

    seen.delete(name)
  }

  for (const name of body.keys()) {
    walk(name, [], new Set())
  }

  return diagnostics
}

const ZERO: Span = { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } }

// ---- node helpers ----
// Local, following compile/host.ts, so the reader stays independent of the code mill.

function headOf(group: GroupNode): string | undefined {
  const head = group.nodes[0]

  return head?.kind === 'name' ? literalText(head) : undefined
}

function keyOf(group: GroupNode): string | undefined {
  const node = group.nodes[1]

  if (node?.kind === 'name' || node?.kind === 'text') {
    return literalText(node)
  }

  if (node?.kind === 'group' && node.nodes[0]?.kind === 'name') {
    return literalText(node.nodes[0])
  }

  return undefined
}

function rest(group: GroupNode): Node[] {
  return group.nodes.slice(1)
}

function textOf(group: GroupNode): string | undefined {
  for (const node of rest(group)) {
    if (node.kind === 'text') {
      return literalText(node)
    }

    if (node.kind === 'group') {
      const inner = node.nodes[0]

      if (inner?.kind === 'text') {
        return literalText(inner)
      }
    }
  }

  return undefined
}

function numberOf(group: GroupNode): number | undefined {
  for (const node of rest(group)) {
    if (node.kind === 'integer' || node.kind === 'decimal' || node.kind === 'radix') {
      return node.value
    }

    if (node.kind === 'group') {
      const inner = node.nodes[0]

      if (inner?.kind === 'integer' || inner?.kind === 'decimal' || inner?.kind === 'radix') {
        return inner.value
      }
    }
  }

  return undefined
}

function literalText(node: NameNode | TextNode): string {
  return node.parts
    .map(part => (part.kind === 'chunk' ? part.text : ''))
    .join('')
}

function spanOf(node: Node | RootNode): Span {
  const zero: Span = { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } }

  switch (node.kind) {
    case 'integer':
    case 'decimal':
    case 'radix':
      return node.token.span
    case 'name':
    case 'text': {
      const chunk = node.parts.find(part => part.kind === 'chunk')

      return chunk?.kind === 'chunk' ? chunk.token.span : zero
    }
    case 'group':
      return node.nodes[0] ? spanOf(node.nodes[0]) : zero
    default:
      return zero
  }
}


// ---- lowering ----
// A document becomes one `zone` Statement per `view`, and nothing downstream changes. `compile/view-lower.ts`
// rewrites a zone into a plain function over the render runtime, so every backend emits it for free. That reuse
// is the whole reason the dialect targets the zone AST rather than carrying one of its own.
//
// A `find` becomes a PARAMETER, never a fetch. The host resolves every query before rendering starts and passes
// the result in, which is what keeps the renderer free of input and output and therefore able to run on a server
// and in a browser with the same code. See note/term/view/03-find.md and 07-lowering.md.
//
// A `host` constant folds into the body at its use sites, so the emitted component takes only what the host must
// supply: its `take` parameters and its resolved queries, in that order.

export function lowerView(file: ViewFile): Program {
  const program: Program = []

  // the constants, by name, folded where they are read
  const fold = new Map<string, Seed>()

  for (const host of file.host) {
    if (host.bond) {
      fold.set(host.name, host.bond)
    }
  }

  // every name the host supplies: a `host` with a type but no value, then every query result
  const supplied: string[] = [
    ...file.host.filter(host => !host.bond).map(host => host.name),
    ...file.find.map(find => find.name),
  ]

  for (const def of file.view) {
    program.push({
      form: 'view',
      name: def.name,
      params: [
        // the view to mount into, first, which is what every zone component takes and what `append` needs. A
        // document never writes it: the host supplies it, the same as it supplies the resolved queries.
        { name: 'host' },
        ...def.take.map(take => ({ name: take.name })),
        ...supplied.map(name => ({ name })),
      ],
      body: def.node.map(node => lowerNode(node, fold)),
      span: def.span,
    })
  }

  return program
}

function lowerNode(node: ViewNode, fold: Map<string, Seed>): CompilerZoneNode {
  switch (node.form) {
    case 'view':
      return {
        form: 'element',
        name: node.value.name,
        // a document never sets an attribute or an event handler, so this is always empty and the reader refuses
        // the spelling that would fill it
        attributes: [],
        props: node.value.bind.map(bind => ({
          name: bind.term,
          value: lowerSeed(bind.bond, fold),
        })),
        children: node.value.node.map(child => lowerNode(child, fold)),
        span: node.span,
      }
    case 'text':
      return { form: 'text', value: node.value, span: node.span }
    case 'walk': {
      const next = node.value.next[0]

      return {
        form: 'walk',
        iterable: lowerSeed(node.value.road, fold),
        item: next?.site ?? 'site',
        body: (next?.node ?? []).map(child => lowerNode(child, fold)),
        span: node.span,
      }
    }
    case 'fork': {
      const branches: { cond: Expression; body: CompilerZoneNode[] }[] = []

      let otherwise: CompilerZoneNode[] | undefined
      let cond: Expression | undefined

      for (const hook of node.value.hook) {
        if (hook.form === 'test') {
          cond = lowerSeed(hook.seed, fold)
          continue
        }

        if (hook.form === 'hold') {
          branches.push({
            cond: cond ?? { form: 'boolean', value: true, span: hook.span },
            body: hook.node.map(child => lowerNode(child, fold)),
          })
          cond = undefined
          continue
        }

        otherwise = hook.node.map(child => lowerNode(child, fold))
      }

      return { form: 'fork', branches, otherwise, span: node.span }
    }
  }
}

function lowerSeed(seed: Seed, fold: Map<string, Seed>): Expression {
  switch (seed.form) {
    case 'text':
    case 'code':
      return { form: 'string', value: seed.value, span: seed.span }
    case 'mark':
      return { form: 'integer', value: seed.value, span: seed.span }
    case 'wave':
      return { form: 'boolean', value: seed.value, span: seed.span }
    case 'read': {
      const [head, ...steps] = seed.value.step

      // a read of a `host` constant IS that constant, folded here, so the emitted component never takes one
      const held = head !== undefined && steps.length === 0 ? fold.get(head) : undefined

      if (held) {
        return lowerSeed(held, fold)
      }

      let expression: Expression = {
        form: 'variable',
        name: head ?? '',
        span: seed.span,
      }

      for (const step of steps) {
        expression = { form: 'member', target: expression, name: step, span: seed.span }
      }

      return expression
    }
    case 'call':
      return {
        form: 'call',
        callee: { form: 'variable', name: seed.value.name, span: seed.span },
        args: [
          ...seed.value.slot.map(one => lowerSeed(one, fold)),
          ...seed.value.bind.map(one => lowerSeed(one.bond, fold)),
        ],
        names: [
          ...seed.value.slot.map(() => undefined),
          ...seed.value.bind.map(one => one.term),
        ],
        span: seed.span,
      }
  }
}


// ---- the query manifest ----
// The host reads this, fills the holes from the document's `host` values, batches by query id, resolves each with
// the READER's permissions, and passes the results into the compiled component as its parameters. So it carries
// what a resolver needs and nothing a renderer could act on.
//
// Written in the `host` dialect, because a manifest is data and the tree already has a data format. `term mold`
// prints it as JSON for a route loader that wants it that way. See note/term/host/ and note/term/view/03-find.md.
//
// Three lists ride along with the queries, all answering questions nothing answers today:
//   - `view`, every component the document places, so "which published documents use text/heading" is answerable
//   - `call`, every operator it applies
//   - `mark`, every record it names, which is what delete protection and cache invalidation walk

export function viewManifest(file: ViewFile, module: string): string {
  const text = (value: string): Data => ({ kind: 'text', value })
  const list = (items: Data[]): Data => ({ kind: 'list', list: items })
  const hash = (entries: [string, Data][]): Data => ({
    kind: 'hash',
    list: entries.map(([name, base]) => ({ name, base })),
  })

  const entries: DataEntry[] = [{ name: 'module', base: text(module) }]

  const put = (name: string, base: Data | undefined): void => {
    if (base) {
      entries.push({ name, base })
    }
  }

  const some = (items: Data[]): Data | undefined =>
    items.length > 0 ? list(items) : undefined

  // the names the host must supply: a `host` with a type and no value
  put(
    'hole',
    some(
      file.host
        .filter(host => !host.bond)
        .map(host =>
          hash([
            ['name', text(host.name)],
            ...(host.like ? ([['like', text(host.like.name)]] as [string, Data][]) : []),
          ]),
        ),
    ),
  )

  const seedData = (seed: Seed): Data =>
    seed.form === 'read'
      ? hash([
          ['form', text('read')],
          ['road', text(seed.value.step.join('/'))],
        ])
      : seed.form === 'text' || seed.form === 'code'
        ? hash([
            ['form', text(seed.form)],
            ['text', text(seed.value)],
          ])
        : seed.form === 'mark'
          ? hash([
              ['form', text('mark')],
              ['code', { kind: 'number', value: seed.value }],
            ])
          : seed.form === 'wave'
            ? hash([
                ['form', text('wave')],
                ['code', { kind: 'flag', value: seed.value }],
              ])
            : hash([
                ['form', text('call')],
                ['call', text(seed.value.name)],
              ])

  const holdData = (hold: ViewHold): Data =>
    hash([
      ['name', text(hold.name)],
      ...(([
        [
          'side',
          some([...hold.slot, ...hold.bind.map(one => one.bond)].map(seedData)),
        ],
      ] as [string, Data | undefined][])
        .filter((pair): pair is [string, Data] => pair[1] !== undefined)),
    ])

  const meetData = (meet: ViewMeet): Data =>
    hash([
      ['mode', text(meet.mode)],
      ...(([
        ['hold', some(meet.hold.map(holdData))],
        ['meet', some(meet.meet.map(meetData))],
      ] as [string, Data | undefined][])
        .filter((pair): pair is [string, Data] => pair[1] !== undefined)),
    ])

  put(
    'find',
    some(
      file.find.map(find =>
        hash([
          ['name', text(find.name)],
          ['task', text(find.task)],
          ...(([
            ['size', find.size === undefined ? undefined : { kind: 'number', value: find.size }],
            ['slot', find.slot === undefined ? undefined : { kind: 'number', value: find.slot }],
            ['meet', find.meet ? meetData(find.meet) : undefined],
            ['hold', some(find.hold.map(holdData))],
            [
              'sort',
              some(
                find.sort.map(sort =>
                  hash([
                    ['way', text(sort.way)],
                    ['road', text(sort.road.step.join('/'))],
                  ]),
                ),
              ),
            ],
          ] as [string, Data | undefined][])
            .filter((pair): pair is [string, Data] => pair[1] !== undefined)),
        ]),
      ),
    ),
  )

  const uses = new Set<string>()
  const calls = new Set<string>()
  const marks = new Set<string>()

  for (const def of file.view) {
    gather(def.node, uses, calls, marks)
  }

  for (const find of file.find) {
    for (const hold of find.hold) {
      gatherSeeds([...hold.slot, ...hold.bind.map(one => one.bond)], calls, marks)
    }

    if (find.meet) {
      gatherMeet(find.meet, calls, marks)
    }
  }

  put('view', some([...uses].sort().map(text)))
  put('call', some([...calls].sort().map(text)))
  put('mark', some([...marks].sort().map(text)))
  put('load', some(file.load.map(load => load.path).sort().map(text)))

  // Written by the host dialect's OWN writer, so the escaping is its escaping. Building the text by hand meant a
  // second spelling of one grammar, and mine escaped three characters where the real one escapes eight: a
  // component name or a value holding a brace, a newline or a tab produced a manifest that did not read back.
  return writeLong({ kind: 'hash', list: entries })
}

function gather(
  nodes: ViewNode[],
  uses: Set<string>,
  calls: Set<string>,
  marks: Set<string>,
): void {
  for (const node of nodes) {
    switch (node.form) {
      case 'view':
        uses.add(node.value.name)
        gatherSeeds(node.value.bind.map(one => one.bond), calls, marks)
        gather(node.value.node, uses, calls, marks)
        break
      case 'walk':
        gatherSeeds([node.value.road], calls, marks)

        for (const next of node.value.next) {
          gather(next.node, uses, calls, marks)
        }

        break
      case 'fork':
        for (const hook of node.value.hook) {
          if (hook.form === 'test') {
            gatherSeeds([hook.seed], calls, marks)
          } else {
            gather(hook.node, uses, calls, marks)
          }
        }

        break
      default:
        break
    }
  }
}

function gatherMeet(meet: ViewMeet, calls: Set<string>, marks: Set<string>): void {
  for (const hold of meet.hold) {
    gatherSeeds([...hold.slot, ...hold.bind.map(one => one.bond)], calls, marks)
  }

  for (const inner of meet.meet) {
    gatherMeet(inner, calls, marks)
  }
}

function gatherSeeds(seeds: Seed[], calls: Set<string>, marks: Set<string>): void {
  for (const seed of seeds) {
    if (seed.form === 'code') {
      marks.add(seed.value)
      continue
    }

    if (seed.form === 'call') {
      // a synthesized call is the render runtime's, not something the document asked for
      if (!seed.value.made) {
        calls.add(seed.value.name)
      }

      gatherSeeds(
        [...seed.value.slot, ...seed.value.bind.map(one => one.bond)],
        calls,
        marks,
      )
    }
  }
}
