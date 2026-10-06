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
//
// As the Term port answers them (compile/lowered-members.tree): each table a task answering its members in order.

export function loweredListMembers(): string[] {
  return [
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
  ]
}

export function loweredMapMembers(): string[] {
  return ['has', 'get', 'set', 'delete', 'keys', 'values']
}

// the one property each answers, read rather than called: a list's `length` and a map's `size`
export function loweredListRead(): string {
  return 'length'
}

export function loweredMapRead(): string {
  return 'size'
}

// THE LIST TASKS THAT ARE THE ARRAY'S OWN LENGTH: `length`, and `size` and `count`, its older names
// (note/term/plan/decisions-2026-10.md, D2). Every emitter writes a call of one as the native length, and the interval
// prover reads it as the list's length. Only `list_size` was known until 2026-10-05, so `length(xs)` became a function
// call where `size(xs)` was `xs.length`, and proved nothing about an index
export function listLengthTasks(): string[] {
  return ['list_length', 'list_size', 'list_count']
}
