// A NATIVE PROGRAM WRITTEN ONE FILE PER TERM MODULE (note/term/plan/incremental-best-in-class.md, step 15).
//
// The native emitters decide representations from the whole program: Rust boxes a recursive form only when nothing
// clones it, and every backend reads list, field and purity facts across every task. Those decisions stay whole. What
// is cut is the output: each top-level statement's text is marked with the Term module it came from as it is emitted,
// every pass after that carries the mark through untouched, and the result is either the one file it always was (the
// marks removed) or one file per module beside a shared one holding the runtime and everything no module owns.
//
// Each file is written only when its text changed (call/code/emit.ts), so an edit to one module rewrites that module's
// file and no other, and the toolchain's own incremental build (rustc's per-item query cache, swiftc and kotlinc per
// file) redoes only what it holds. test/compile/native-units.ts holds the split program to the whole one on rustc,
// swiftc and kotlinc, and the one-file rewrite.
//
// The mark is three private-use characters, which no emitted program holds: open, the file, close, the text, end.

const OPEN = ''
const CLOSE = ''
const END = ''

// a statement's text, marked with the module it came from. Nothing is marked without a file (a statement the build
// made, such as a runtime struct) or without text
export function markUnit(file: string | undefined, text: string): string {
  return file && text ? `${OPEN}${file}${CLOSE}${text}${END}` : text
}

// the program as one file, every mark removed
export function unmarked(text: string): string {
  return text.includes(OPEN) ? text.replace(/[^]*/g, '').split(END).join('') : text
}

// the program cut by module: what no module owns, in its order, and each module's statements, in their order
export function splitUnits(text: string): { shared: string; units: [string, string][] } {
  const units = new Map<string, string[]>()
  let shared = ''
  let at = 0

  while (at < text.length) {
    const open = text.indexOf(OPEN, at)

    if (open < 0) {
      shared += text.slice(at)
      break
    }

    shared += text.slice(at, open)

    const close = text.indexOf(CLOSE, open)
    const end = text.indexOf(END, close)
    const file = text.slice(open + 1, close)
    units.set(file, [...(units.get(file) ?? []), text.slice(close + 1, end)])
    at = end + 1
  }

  // the blank lines a removed statement left between two shared parts, closed up
  return { shared: shared.replace(/\n{3,}/g, '\n\n'), units: [...units].map(([file, parts]) => [file, `${parts.join('\n\n')}\n`]) }
}
