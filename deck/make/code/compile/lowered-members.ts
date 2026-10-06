// THE MEMBERS A NATIVE LIST AND A NATIVE MAP ANSWER THEMSELVES, ONE TABLE (note/term/plan/backends-complete.md, step 5).
// A `list` value is the host's array and a `hash` the host's map, and a member call on one is either a member every
// emitter lowers (these, camelCase as a member call emits them: `xs/index-of` is `indexOf`) or a method of the Term
// form, which the checker dispatches to (check/infer.ts `bindMemberMethod`).
//
// There were two tables until 2026-10-05, and they disagreed. The checker's said a list answers `reverse`, `sort`,
// `find`, `forEach`, `entries`, `keys` and `values` itself on every backend, and no native emitter lowered one of them,
// so `walk list, call items/reverse` was written as the host call `items.reverse()`: in place on TypeScript, where the
// Term method copies, and a build failure on Rust, Swift and Kotlin, found in the toolchain. Now the checker leaves
// native only what is here (compile/backend.ts `collectionCall` lowers exactly these), a member call outside it
// dispatches to the Term method of that name, and one with no Term method is refused on a native build before
// anything is emitted (check/lowered.ts).

export const LOWERED_LIST_MEMBERS: ReadonlySet<string> = new Set([
  'push',
  'pop',
  'at',
  'get',
  'set',
  'includes',
  'indexOf',
  'lastIndexOf',
  'concat',
  'slice',
  'toReversed',
  'join',
  'map',
  'filter',
  'some',
  'every',
  'reduce',
  'findIndex',
  'flat',
  'shift',
  'unshift',
  'splice',
])

export const LOWERED_MAP_MEMBERS: ReadonlySet<string> = new Set(['has', 'get', 'set', 'delete', 'keys', 'values'])

// the one property each answers, read rather than called: a list's `length` and a map's `size`
export const LOWERED_LIST_READ = 'length'
export const LOWERED_MAP_READ = 'size'
