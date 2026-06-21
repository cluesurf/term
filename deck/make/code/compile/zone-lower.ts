// Zone lowering: rewrite every `zone` (view component) Statement into a plain
// `function` Statement whose body builds the DOM through ordinary calls to the
// reactive-render runtime (`element` / `text` / `dynamic` / `attribute` /
// `event` / `append` / `show` / `each`) plus component calls. After this pass
// the program contains NO `form: 'zone'` statements, so every backend emits
// components for free as ordinary functions — the composition logic lives here,
// once, instead of being reimplemented in each code generator.
//
// The zone's attribute / prop / read values are already `Expression` IR (the
// mill produced them), so lowering only assembles `let` / `expression` / `if`
// statements and `call` / `closure` expressions AROUND those existing nodes.
//
// Components compose two ways, both handled here:
//   - a `zone <name>` whose name is another component  -> a call to that
//     component's function, passing props by name and the children as a
//     `() => view` thunk.
//   - a `slot` inside a component -> the outlet that builds the caller's
//     children thunk under its parent.

import type {
  Program,
  Statement,
  Expression,
  ZoneNode,
  Type,
} from '@cluesurf/make/code/compile/node'
import type { Span } from '@cluesurf/make/code/parser/diagnostic'

// The render-runtime + component functions are referenced by bare name (a
// `variable` callee with no binding -> the emitter writes `name(args)`); the
// page imports the render runtime, and component names resolve to their lowered
// functions.

type Component = { params: string[]; slotted: boolean }

// Standard HTML/SVG tags that are ALWAYS rendered as elements, never treated as
// component calls even if a same-named zone exists. Kebab zone names have no
// case to distinguish a component from a tag (unlike React's <Button> vs
// <button>), and the component registry is program-wide, so without this a
// module defining `zone span` would hijack every `zone span` everywhere. This
// is the curated set of structural / text / form primitives rendered raw inside
// components. It deliberately EXCLUDES tags that make good component names and
// are rarely written raw (dialog, select, progress, menu, meter, output,
// details, summary), so those remain available as components.
const HTML_TAGS = new Set<string>([
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base',
  'bdi', 'bdo', 'blockquote', 'body', 'br', 'button', 'canvas', 'caption',
  'cite', 'code', 'col', 'colgroup', 'data', 'datalist', 'dd', 'del',
  'dfn', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img',
  'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map',
  'mark', 'meta', 'nav', 'object', 'ol', 'optgroup',
  'option', 'p', 'param', 'picture', 'pre', 'q',
  'rp', 'rt', 'ruby', 's', 'samp', 'script', 'section',
  'small', 'source', 'span', 'strong', 'style', 'sub', 'sup',
  'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead',
  'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr',
  'svg', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'g',
  'defs', 'use', 'symbol', 'ellipse', 'tspan',
])

// build the program-wide component registry: name -> its input params (after
// the leading `host`) and whether its body has a `slot`.
function collectComponents(program: Program): Map<string, Component> {
  const components = new Map<string, Component>()

  for (const node of program) {
    // a zone named after an HTML tag is not a component (it would be
    // unreachable as one anyway, since `zone <tag>` renders the element); skip
    // it so `components.has(name)` cleanly means "this is a component call".
    if (node.form === 'zone' && !HTML_TAGS.has(node.name)) {
      components.set(node.name, {
        params: node.params.slice(1).map(p => p.name),
        slotted: hasSlot(node.body),
      })
    }
  }

  return components
}

function hasSlot(nodes: ZoneNode[]): boolean {
  for (const node of nodes) {
    if (node.form === 'slot') {return true}

    if (node.form === 'element' && hasSlot(node.children)) {return true}

    if (node.form === 'fork') {
      if (node.branches.some(b => hasSlot(b.body))) {return true}

      if (node.otherwise && hasSlot(node.otherwise)) {return true}
    }

    if (node.form === 'walk' && hasSlot(node.body)) {return true}
  }

  return false
}

// lower one zone Statement into a function Statement.
function lowerZone(
  zone: Extract<Statement, { form: 'zone' }>,
  components: Map<string, Component>,
): Statement {
  const span = zone.span
  let counter = 0
  const fresh = (): string => `view${counter++}`

  const variable = (name: string): Expression => ({
    form: 'variable',
    name,
    span,
  })

  const string = (value: string): Expression => ({
    form: 'string',
    value,
    span,
  })

  const call = (name: string, args: Expression[]): Expression => ({
    form: 'call',
    callee: variable(name),
    args,
    span,
  })

  const exprStatement = (expr: Expression): Statement => ({
    form: 'expression',
    expr,
    span,
  })

  // an attribute set on an element. A literal value is set once (`attribute`);
  // a dynamic value (a signal/prop read, call, etc.) is kept in sync via an
  // effect (`bind-attribute` with a getter), so `data-state` / `aria-*` / a
  // signal-bound `class` update reactively — the Solid model for attributes.
  const attributeStatement = (
    ref: string,
    name: string,
    value: Expression,
  ): Statement =>
    value.form === 'string'
      ? exprStatement(
          call('attribute', [variable(ref), string(name), value]),
        )
      : exprStatement(
          call('bind-attribute', [
            variable(ref),
            string(name),
            {
              form: 'closure',
              params: [],
              body: [{ form: 'return', value, span }],
              span,
            },
          ]),
        )

  const slotted = components.get(zone.name)?.slotted ?? hasSlot(zone.body)

  // build a body list as a `(params) => view` thunk returning exactly one node.
  // A single static node is returned directly (no wrapper) so list/conditional
  // reconciliation sees one node per item; anything else (0 or 2+ nodes, or a
  // component, which mounts into a container) goes under a `seed-fragment`.
  // Used for slots, component children, and fork / walk branch bodies.
  const fragmentThunk = (
    params: { name: string; type?: Type }[],
    body: ZoneNode[],
  ): Expression => {
    const inner: Statement[] = []
    const only = body[0]

    if (
      body.length === 1 &&
      only &&
      (only.form === 'text' ||
        only.form === 'read' ||
        (only.form === 'element' && !components.has(only.name)))
    ) {
      const ref = build(only, inner)
      inner.push({ form: 'return', value: variable(ref), span })
    } else {
      const frag = fresh()

      inner.push({
        form: 'let',
        name: frag,
        init: call('element', [string('seed-fragment')]),
        mutable: false,
        span,
      })

      for (const child of body) {attach(child, frag, inner)}

      inner.push({ form: 'return', value: variable(frag), span })
    }

    return { form: 'closure', params, body: inner, span }
  }

  const thunk = (body: ZoneNode[]): Expression => fragmentThunk([], body)

  // a component instance call: name(parent, ...propsByParamOrder, childrenThunk?)
  const componentCall = (
    node: Extract<ZoneNode, { form: 'element' }>,
    parent: string,
  ): Expression => {
    const comp = components.get(node.name)!
    const args: Expression[] = [variable(parent)]

    for (const name of comp.params) {
      const prop = node.props.find(p => p.name === name)
      args.push(prop ? prop.value : { form: 'unit', span })
    }

    if (comp.slotted)
      {args.push(
        node.children.length
          ? thunk(node.children)
          : { form: 'unit', span },
      )}

    return call(node.name, args)
  }

  // build a node, appending its statements to `out`, returning the variable
  // name of the built node (for nodes that produce a single element/text).
  const build = (node: ZoneNode, out: Statement[]): string => {
    const ref =
      node.form === 'element' && node.ref ? node.ref : fresh()

    if (node.form === 'text') {
      out.push({
        form: 'let',
        name: ref,
        init: call('text', [string(node.value)]),
        mutable: false,
        span,
      })
    } else if (node.form === 'read') {
      out.push({
        form: 'let',
        name: ref,
        init: call('dynamic', [
          { form: 'closure', params: [], body: [{ form: 'return', value: node.value, span }], span },
        ]),
        mutable: false,
        span,
      })
    } else if (node.form === 'element' && components.has(node.name)) {
      // a component where a single returnable node is required: mount it into a
      // container we can return.
      out.push({
        form: 'let',
        name: ref,
        init: call('element', [string('seed-part')]),
        mutable: false,
        span,
      })
      out.push(exprStatement(componentCall(node, ref)))
    } else if (node.form === 'element') {
      out.push({
        form: 'let',
        name: ref,
        init: call('element', [string(node.name)]),
        mutable: false,
        span,
      })

      for (const attribute of node.attributes)
        {out.push(
          attribute.event
            ? exprStatement(
                call('event', [
                  variable(ref),
                  string(attribute.name),
                  { form: 'closure', params: [], body: [{ form: 'return', value: attribute.value, span }], span },
                ]),
              )
            : attributeStatement(ref, attribute.name, attribute.value),
        )}

      // `bind <name>, <value>` on an HTML element is an attribute (on a
      // component it is a prop, handled by componentCall). Emit them here.
      for (const prop of node.props)
        {out.push(attributeStatement(ref, prop.name, prop.value))}

      for (const child of node.children) {attach(child, ref, out)}
    } else {
      out.push({
        form: 'let',
        name: ref,
        init: call('text', [string('')]),
        mutable: false,
        span,
      })
    }

    return ref
  }

  // attach a node under `parent`: build + append, or lower control flow / slots
  // / component calls (which mount themselves).
  const attach = (node: ZoneNode, parent: string, out: Statement[]): void => {
    if (node.form === 'fork') {
      // show(parent, () => cond, () => then, () => else)
      const branch = node.branches[0]
      out.push(
        exprStatement(
          call('show', [
            variable(parent),
            { form: 'closure', params: [], body: [{ form: 'return', value: branch?.cond ?? { form: 'boolean', value: false, span }, span }], span },
            thunk(branch?.body ?? []),
            thunk(node.otherwise ?? []),
          ]),
        ),
      )
    } else if (node.form === 'walk') {
      // each(parent, () => iterable, (item) => view)
      const itemBody = fragmentThunk([{ name: node.item }], node.body)
      out.push(
        exprStatement(
          call('each', [
            variable(parent),
            { form: 'closure', params: [], body: [{ form: 'return', value: node.iterable, span }], span },
            itemBody,
          ]),
        ),
      )
    } else if (node.form === 'slot') {
      // if (children) append(parent, children())
      out.push({
        form: 'if',
        branches: [
          {
            cond: variable('children'),
            body: [
              exprStatement(
                call('append', [
                  variable(parent),
                  { form: 'call', callee: variable('children'), args: [], span },
                ]),
              ),
            ],
          },
        ],
        span,
      })
    } else if (node.form === 'element' && components.has(node.name)) {
      out.push(exprStatement(componentCall(node, parent)))
    } else if (node.form === 'save') {
      out.push({
        form: 'let',
        name: node.name,
        init: node.value,
        mutable: false,
        span,
      })
    } else {
      const ref = build(node, out)
      out.push(exprStatement(call('append', [variable(parent), variable(ref)])))
    }
  }

  // the function body: declare top-level `save`s first (so later nodes can read
  // them), then attach each view node under `host`.
  const host = zone.params[0]?.name ?? 'host'
  const body: Statement[] = []

  for (const node of zone.body)
    {if (node.form === 'save')
      {body.push({ form: 'let', name: node.name, init: node.value, mutable: false, span })}}

  for (const node of zone.body)
    {if (node.form !== 'save') {attach(node, host, body)}}

  const params = zone.params.map(p => ({ name: p.name, type: p.type }))

  if (slotted) {params.push({ name: 'children', type: undefined })}

  return {
    form: 'function',
    name: zone.name,
    params,
    body,
    generics: [],
    span,
  }
}

// the pass: replace every zone with its lowered function.
export function lowerZones(program: Program): Program {
  const components = collectComponents(program)

  if (components.size === 0) {return program}

  return program.map(node =>
    node.form === 'zone' ? lowerZone(node, components) : node,
  )
}
