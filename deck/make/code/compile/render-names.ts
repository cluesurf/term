// The render runtime's task names (deck/site/code/view/render.tree): the ONE place the compiler spells them. The view
// lowering (view-lower.ts), the TypeScript zone emitter (typescript.ts), the counted walk (view.ts) and the three lists
// that keep the runtime alive through pruning and inlining (compile.ts, modules.ts, ir/simplify.ts) all read these, so a
// rename in render.tree is one edit here. Every task is a verb (`make-text`, never `text`), so the names a component
// or a form needs stay free.

export const RENDER = {
  element: 'make-element',
  text: 'make-text',
  dynamic: 'make-dynamic-text',
  attribute: 'write-attribute',
  bindAttribute: 'bind-attribute',
  event: 'attach-event',
  show: 'show',
  each: 'render-each',
  eachKeyed: 'render-each-keyed',
  dynamicView: 'render-dynamic-view',
  gate: 'render-gate',
  mount: 'mount',
  portal: 'mount-portal',
  // the items a counted `walk size` walks, made by render.tree for the view role's lowering
  integers: 'list-integers',
} as const
