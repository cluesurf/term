// View lowering: rewrite every `zone` (view component) Statement into a plain
// `function` Statement whose body builds the DOM through ordinary calls to the
// reactive-render runtime (`make-element` / `make-text` / `make-dynamic-text` /
// `write-attribute` / `attach-event` / `append` / `show` / `render-each`, named in
// ./render-names.ts) plus component calls. After this pass
// the program contains NO `form: 'view'` statements, so every backend emits
// components for free as ordinary functions — the composition logic lives here,
// once, instead of being reimplemented in each code generator.
//
// The zone's attribute / prop / read values are already `Expression` IR (the
// mill produced them), so lowering only assembles `let` / `expression` / `if`
// statements and `call` / `closure` expressions AROUND those existing nodes.
//
// Components compose two ways, both handled here:
//   - a `view <name>` whose name is another component  -> a call to that
//     component's function, passing props by name and the children as a
//     `() => view` thunk.
//   - a `slot` inside a component -> the outlet that builds the caller's
//     children thunk under its parent.

import type {
  Program,
  Statement,
  Expression,
  ViewNode,
  Type,
} from '@term/make/code/compile/node'
import type { Span } from '@term/make/code/parser/diagnostic'
import { RENDER } from '@term/make/code/compile/render-names'

// the name a guarded event handler binds what it caught to, before handing it to the render runtime's `keep-raise`
const HANDLER_RAISE = 'raised-in-handler'

// The render-runtime + component functions are referenced by bare name (a
// `variable` callee with no binding -> the emitter writes `name(args)`); the
// page imports the render runtime, and component names resolve to their lowered
// functions.

type Component = { params: string[]; types: (Type | undefined)[]; slotted: boolean }

// the render runtime's node handle, the type every outlet hands to a children closure
const VIEW: Type = { kind: 'named', name: 'view' }

// the value a placement passes for a prop it leaves out: the prop type's own empty (``, 0, false), so a component's
// optional props (the vocabulary's `level` and `link` on `text`) type on every backend, where a bare unit is only
// accepted by TypeScript. Anything else, or an untyped prop, gets the unit as before
function emptyFor(type: Type | undefined, span: Span): Expression {
  const name = type?.kind === 'named' ? type.name : type?.kind

  switch (name) {
    case 'text':
    case 'string':
      return { form: 'string', value: '', span }
    case 'number':
    case 'integer':
    case 'natural':
    case 'size':
      return { form: 'integer', value: 0, span }
    case 'decimal':
    case 'float':
      return { form: 'float', value: 0, span }
    case 'boolean':
      return { form: 'boolean', value: false, span }
    default:
      return { form: 'unit', span }
  }
}

// Standard HTML/SVG tags that are ALWAYS rendered as elements, never treated as
// component calls even if a same-named zone exists. Kebab zone names have no
// case to distinguish a component from a tag (unlike React's <Button> vs
// <button>), and the component registry is program-wide, so without this a
// module defining `view span` would hijack every `view span` everywhere. This
// is the curated set of structural / text / form primitives rendered raw inside
// components. It deliberately EXCLUDES tags that make good component names and
// are rarely written raw (dialog, select, progress, menu, meter, output,
// details, summary), so those remain available as components.
export const HTML_TAGS = new Set<string>([
  'a',
  'abbr',
  'address',
  'area',
  'article',
  'aside',
  'audio',
  'b',
  'base',
  'bdi',
  'bdo',
  'blockquote',
  'body',
  'br',
  'button',
  'canvas',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'data',
  'datalist',
  'dd',
  'del',
  'dfn',
  'div',
  'dl',
  'dt',
  'em',
  'embed',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hgroup',
  'hr',
  'html',
  'i',
  'iframe',
  'img',
  'input',
  'ins',
  'kbd',
  'label',
  'legend',
  'li',
  'link',
  'main',
  'map',
  'mark',
  'meta',
  'nav',
  'object',
  'ol',
  'optgroup',
  'option',
  'p',
  'param',
  'picture',
  'pre',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'script',
  'section',
  'small',
  'source',
  'span',
  'strong',
  'style',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'template',
  'textarea',
  'tfoot',
  'th',
  'thead',
  'time',
  'title',
  'tr',
  'track',
  'u',
  'ul',
  'var',
  'video',
  'wbr',
  'svg',
  'path',
  'circle',
  'rect',
  'line',
  'polyline',
  'polygon',
  'g',
  'defs',
  'use',
  'symbol',
  'ellipse',
  'tspan',
])

// build the program-wide component registry: name -> its input params (after
// the leading `host`) and whether its body has a `slot`.
function collectComponents(program: Program): Map<string, Component> {
  const components = new Map<string, Component>()

  for (const node of program) {
    // a zone named after an HTML tag is not a component (it would be
    // unreachable as one anyway, since `view <tag>` renders the element); skip
    // it so `components.has(name)` cleanly means "this is a component call".
    if (node.form === 'view' && !HTML_TAGS.has(node.name)) {
      components.set(node.name, {
        params: node.params.slice(1).map(p => p.name),
        types: node.params.slice(1).map(p => p.type),
        slotted: hasSlot(node.body),
      })
    }
  }

  return components
}

function hasSlot(nodes: ViewNode[]): boolean {
  for (const node of nodes) {
    if (node.form === 'slot') {
      return true
    }

    if (node.form === 'element' && hasSlot(node.children)) {
      return true
    }

    if (node.form === 'fork') {
      if (node.branches.some(b => hasSlot(b.body))) {
        return true
      }

      if (node.otherwise && hasSlot(node.otherwise)) {
        return true
      }
    }

    if (node.form === 'walk' && hasSlot(node.body)) {
      return true
    }
  }

  return false
}

// lower one zone Statement into a function Statement.
function lowerZone(
  zone: Extract<Statement, { form: 'view' }>,
  components: Map<string, Component>,
): Statement {
  const span = zone.span

  let counter = 0

  const fresh = (): string => `view${counter++}`

  // the element type of a walk over a prop declared `like list, like item`, given to the item: left untyped, the
  // closure's parameter was never tied to render-each's element and emitted as `row: number` over `items: Item[]`
  // (guides: applications/web/components, 2026-10-03). Any other iterable leaves the item to inference
  const elementOf = (iterable: Expression): Type | undefined => {
    if (iterable.form !== 'variable') {
      return undefined
    }

    const type = zone.params.find(p => p.name === iterable.name)?.type

    if (type?.kind === 'array') {
      return type.element.kind === 'variable' ? undefined : type.element
    }

    return type?.kind === 'named' && type.name === 'list' && type.args?.length === 1 ? type.args[0] : undefined
  }

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
          call(RENDER.attribute, [variable(ref), string(name), value]),
        )
      : exprStatement(
          call(RENDER.bindAttribute, [
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

  const slotted =
    components.get(zone.name)?.slotted ?? hasSlot(zone.body)

  // build a body list as a `(params) => view` thunk returning exactly one node.
  // A single static node is returned directly (no wrapper) so list/conditional
  // reconciliation sees one node per item; anything else (0 or 2+ nodes, or a
  // component, which mounts into a container) goes under a `seed-fragment`.
  // Used for slots, component children, and fork / walk branch bodies.
  const fragmentThunk = (
    params: { name: string; type?: Type }[],
    body: ViewNode[],
  ): Expression => {
    const inner: Statement[] = []
    const only = body[0]

    if (
      body.length === 1 &&
      only &&
      (only.form === 'text' ||
        only.form === 'read' ||
        (only.form === 'element' &&
          (!components.has(only.name) || only.forced)))
    ) {
      const ref = build(only, inner)
      inner.push({ form: 'return', value: variable(ref), span })
    } else {
      const frag = fresh()

      inner.push({
        form: 'let',
        name: frag,
        init: call(RENDER.element, [string('seed-fragment')]),
        mutable: false,
        span,
      })

      for (const child of body) {
        attach(child, frag, inner)
      }

      inner.push({ form: 'return', value: variable(frag), span })
    }

    return { form: 'closure', params, body: inner, span }
  }

  const thunk = (body: ViewNode[]): Expression =>
    fragmentThunk([], body)

  // a component instance call: name(parent, ...propsByParamOrder, childrenThunk?)
  const componentCall = (
    node: Extract<ViewNode, { form: 'element' }>,
    parent: string,
  ): Expression => {
    const comp = components.get(node.name)!
    const args: Expression[] = [variable(parent)]

    comp.params.forEach((name, i) => {
      const prop = node.props.find(p => p.name === name)
      args.push(prop ? prop.value : emptyFor(comp.types[i], span))
    })

    // the children build STRAIGHT INTO the parent the outlet hands them (`(into) => { ... }`), as a route's page builds
    // into its layout's: never under a `seed-fragment` wrapper, which sat between a layout component (the vocabulary's
    // `stack`) and its children, so a flex row laid out one fragment instead of its children
    // the parameter is the view the outlet hands over, typed: untyped it defaulted to `number` on TypeScript
    if (comp.slotted) {
      if (node.children.length) {
        const into = fresh()
        const inner: Statement[] = []

        for (const child of node.children) {
          attach(child, into, inner)
        }

        args.push({ form: 'closure', params: [{ name: into, type: VIEW }], body: inner, span })
      } else {
        // no children: a closure that builds nothing, never a unit, so the parameter keeps its one type everywhere
        args.push({ form: 'closure', params: [{ name: fresh(), type: VIEW }], body: [], span })
      }
    }

    return call(node.name, args)
  }

  // build a node, appending its statements to `out`, returning the variable
  // name of the built node (for nodes that produce a single element/text).
  const build = (node: ViewNode, out: Statement[]): string => {
    const ref = node.form === 'element' && node.ref ? node.ref : fresh()

    if (node.form === 'text') {
      out.push({
        form: 'let',
        name: ref,
        init: call(RENDER.text, [string(node.value)]),
        mutable: false,
        span,
      })
    } else if (node.form === 'read') {
      out.push({
        form: 'let',
        name: ref,
        init: call(RENDER.dynamic, [
          {
            form: 'closure',
            params: [],
            body: [{ form: 'return', value: node.value, span }],
            span,
          },
        ]),
        mutable: false,
        span,
      })
    } else if (
      node.form === 'element' &&
      components.has(node.name) &&
      !node.forced
    ) {
      // a component where a single returnable node is required: mount it into a
      // container we can return.
      out.push({
        form: 'let',
        name: ref,
        init: call(RENDER.element, [string('seed-part')]),
        mutable: false,
        span,
      })
      out.push(exprStatement(componentCall(node, ref)))
    } else if (node.form === 'element') {
      out.push({
        form: 'let',
        name: ref,
        init: call(RENDER.element, [string(node.name)]),
        mutable: false,
        span,
      })

      for (const attribute of node.attributes) {
        // a handler is a function: a single expression (`seed click / call submit`) is wrapped in one, and a body of
        // several statements, which the mill already made a closure, is passed as it is. Wrapping that closure again
        // built the handler and never called it, so a click whose handler had two statements did nothing (found by
        // test/view/terminal-input.ts, 2026-10-03). typescript.ts's emitZone makes the same distinction
        //
        // And every handler's body is GUARDED (swiftui-target-0003): a raise that escapes it goes to the render runtime's
        // `keep-raise`, which keeps its note where a view can show it, and the app goes on. Unguarded, a raise in a click
        // handler ended the program on Swift (`try!` in the closure) and Kotlin (an exception out of the listener)
        const body: Statement[] =
          attribute.value.form === 'closure' ? attribute.value.body : [{ form: 'expression', expr: attribute.value, span }]
        const params = attribute.value.form === 'closure' ? attribute.value.params : []
        const guarded: Statement = {
          form: 'guard',
          body,
          catch: {
            name: HANDLER_RAISE,
            // the note, read off the caught value: natively that value is the backend's carrier (`TermException`), not
            // the generic `exception` form, and every backend's carrier has the note
            body: [
              {
                form: 'expression',
                expr: call(RENDER.raise, [{ form: 'member', target: variable(HANDLER_RAISE), name: 'note', span }]),
                span,
              },
            ],
            span,
          },
          span,
        }
        const handler: Expression = attribute.value.form === 'closure'
          ? { ...attribute.value, params, body: [guarded] }
          : { form: 'closure', params, body: [guarded], span }

        out.push(
          attribute.event
            ? exprStatement(call(RENDER.event, [variable(ref), string(attribute.name), handler]))
            : attributeStatement(ref, attribute.name, attribute.value),
        )
      }

      // `bind <name>, <value>` on an HTML element is an attribute (on a
      // component it is a prop, handled by componentCall). Emit them here.
      for (const prop of node.props) {
        out.push(attributeStatement(ref, prop.name, prop.value))
      }

      for (const child of node.children) {
        attach(child, ref, out)
      }
    } else {
      out.push({
        form: 'let',
        name: ref,
        init: call(RENDER.text, [string('')]),
        mutable: false,
        span,
      })
    }

    return ref
  }

  // attach a node under `parent`: build + append, or lower control flow / slots
  // / component calls (which mount themselves).
  const attach = (
    node: ViewNode,
    parent: string,
    out: Statement[],
  ): void => {
    if (node.form === 'fork') {
      // show(parent, () => cond, () => then, () => else)
      const branch = node.branches[0]
      out.push(
        exprStatement(
          call(RENDER.show, [
            variable(parent),
            {
              form: 'closure',
              params: [],
              body: [
                {
                  form: 'return',
                  value: branch?.cond ?? {
                    form: 'boolean',
                    value: false,
                    span,
                  },
                  span,
                },
              ],
              span,
            },
            thunk(branch?.body ?? []),
            thunk(node.otherwise ?? []),
          ]),
        ),
      )
    } else if (node.form === 'walk') {
      // render-each(parent, () => iterable, (item) => view)
      const element = elementOf(node.iterable)
      const itemBody = fragmentThunk([{ name: node.item, ...(element ? { type: element } : {}) }], node.body)
      out.push(
        exprStatement(
          call(RENDER.each, [
            variable(parent),
            {
              form: 'closure',
              params: [],
              body: [{ form: 'return', value: node.iterable, span }],
              span,
            },
            itemBody,
          ]),
        ),
      )
    } else if (node.form === 'slot') {
      // the slot outlet renders the caller's children into `parent`. Every children thunk builds straight into the parent
      // it is handed and returns nothing: a component's children (componentCall) and a route layout's page
      // (route-lower.ts) alike, and a placement with none passes one that builds nothing. So no wrapper element ever
      // sits between a component and its children, and the call needs no test of whether there are any.
      //   children(parent)
      out.push(
        exprStatement({
          form: 'call',
          callee: variable('children'),
          args: [variable(parent)],
          span,
        }),
      )
    } else if (
      node.form === 'element' &&
      components.has(node.name) &&
      !node.forced
    ) {
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
      out.push(
        exprStatement(
          call('append', [variable(parent), variable(ref)]),
        ),
      )
    }
  }

  // the function body: declare top-level `save`s first (so later nodes can read
  // them), then attach each view node under `host`.
  const host = zone.params[0]?.name ?? 'host'
  const body: Statement[] = []

  for (const node of zone.body) {
    if (node.form === 'save') {
      body.push({
        form: 'let',
        name: node.name,
        init: node.value,
        mutable: false,
        span,
      })
    }
  }

  for (const node of zone.body) {
    if (node.form !== 'save') {
      attach(node, host, body)
    }
  }

  const params = zone.params.map(p => ({ name: p.name, type: p.type }))

  if (slotted) {
    // a task that builds into the view it is handed: typed, so a native backend (whose closures are typed) emits a real
    // function type, where an untyped parameter was `Void` on Swift (view-vocabulary-0004, the first native slot)
    params.push({
      name: 'children',
      type: { kind: 'function', params: [VIEW], result: { kind: 'unit' } },
    })
  }

  // a component builds into its host and returns nothing, so it says so: without a result the checker left it a
  // variable that defaulted to `number`, and TypeScript emitted `counter(host: View): number` over a body with no
  // return (guides: applications/web/components, 2026-10-03)
  return {
    form: 'function',
    name: zone.name,
    params,
    body,
    result: { kind: 'unit' },
    generics: [],
    span,
  }
}

// the pass: replace every zone with its lowered function.
export function lowerZones(program: Program): Program {
  const components = collectComponents(program)

  if (components.size === 0) {
    return program
  }

  return program.map(node =>
    node.form === 'view' ? lowerZone(node, components) : node,
  )
}
