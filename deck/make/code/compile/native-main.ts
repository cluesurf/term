// THE MAIN THAT CALLS A PROGRAM, written once for every backend: what `term make --emit X --build` appends and what the
// test harnesses append, so a program runs the same way under both (note/term/plan/backends-complete.md, step 1).
//
// It drives the entry the way its signature asks: an asynchronous one on the program's executor (Rust's
// `__term_block_on`, Kotlin's `termLoop`, Swift's top-level `await`), a raising one to its raise on stderr and exit 1,
// and prints what it answered with no line break after it, or nothing for an entry that answers nothing (`boot`).
//
// AND IT RUNS THE ENTRY ON A THREAD WITH A LARGE STACK on Rust, Swift and Kotlin, as GHC's and OCaml's runtimes give
// theirs. A recursive form is released recursively by Swift (an `indirect enum` has no `deinit` to unlink it in a loop),
// so a linked list of 200,000 nodes ended the program when it was dropped, with no message, where Rust and Kotlin went
// on (test/stdlib/ordered-collections.ts, 2026-10-05). The same stack holds a deep recursion in the program's own code
// alike on all three. 1 GiB is reserved address space, not memory: a page is committed only when it is touched.
// TypeScript runs on node's own stack, which a program cannot widen safely.

import * as mainEntry from '@term/make/code/compile/main-entry'

export type MainBackend = 'rust' | 'swift' | 'kotlin'

// The names and the mains are Term, compile/main-entry.tree (self-hosting, 2026-10-06), its regular expressions written
// out by character. This face keeps the constants as callers read them.
export const ENTRY_STACK_BYTES = mainEntry.entryStackBytes()

// the entries a program is run by, in the order one is chosen when none is named
export const ENTRY_NAMES = mainEntry.entryNames()

// a Term task name as each backend spells it: `run-all` is `run_all` on Rust and `runAll` elsewhere. `main` is `main_`
// on Rust and Kotlin, which reserve it for the main this module writes (compile/rust.ts `RUST_RESERVED`, kotlin.ts `camel`)
export function entrySpelling(backend: MainBackend | 'node', name: string): string {
  return mainEntry.entrySpelling(backend, name)
}

// the entry `emitted` defines: `named`, or the first of ENTRY_NAMES it has, as the backend spells it
export function entryOf(backend: MainBackend | 'node', emitted: string, named?: string): string | undefined {
  const found = mainEntry.entryOf(backend, emitted, named ? { form: 'some', value: named } : { form: 'none' })

  return found.form === 'some' ? found.value : undefined
}

// the main for `entry` (already spelled for the backend) in `emitted`, a backend's output, to be appended to it.
// `threads` false is a Rust main with no thread of its own, for a target that has none: WebAssembly under WASI
export function nativeMain(backend: MainBackend, emitted: string, entry = 'run', threads = true): string {
  return mainEntry.nativeMain(backend, emitted, entry, threads)
}

// the stdlib's crates (`cargoToml` is deck/base/code/native/rust/Cargo.toml) a Rust source names, each as its manifest
// line: a program that names one is a cargo project with those crates alone
export function cratesNamed(source: string, cargoToml: string): string[] {
  return mainEntry.cratesNamed(source, cargoToml)
}
