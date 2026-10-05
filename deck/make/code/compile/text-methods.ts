// the host string methods the stdlib's `text.tree` delegates to (`call value/char-at` is JavaScript's `charAt`), so
// a native backend renders each in its own string API instead of emitting a method the platform does not have.
// The semantics are JavaScript's: an index past the end reads as empty, `indexOf` gives -1, `split` on an empty
// delimiter gives the characters, `replace` touches the first match and `replaceAll` every one.
//
// Its own module because the checker reads it too: a member call on a text that names none of these is refused
// there (check/infer.ts), where until 2026-10-04 `s/frobnicate` built to `s.frobnicate()` and failed at run time
export const STRING_METHODS = new Set([
  'charAt',
  'at',
  'charCodeAt',
  'indexOf',
  'lastIndexOf',
  'split',
  'substring',
  'slice',
  'toLowerCase',
  'toUpperCase',
  'startsWith',
  'endsWith',
  'trim',
  'trimStart',
  'trimEnd',
  'padStart',
  'padEnd',
  'replace',
  'replaceAll',
  'includes',
  'repeat',
  'concat',
  // not a JavaScript method: the stdlib's code-point comparison (`ordering/from-texts`), -1, 0 or 1
  'compare',
])

// the member name as the host spells it: the stdlib writes `call value/char-at`, the JavaScript method is `charAt`
export function hostMethod(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}
