// Whether a module's text shelves it out of port-build (term-self-host-001-0296): an unindented `mark draft` line, or
// the old `note draft`, ANYWHERE in the file. It is the pattern deck/call/code/draft.ts's `declaresDraft` and every
// other tool that skips shelved files test. port-build read it only in the first 2000 characters until 2026-10-27, so
// compile/program-gate.tree, whose marker sat at line 27 under a long header, was compiled as a port, failed, and
// stopped make:line before esbuild (traps.md T-0294 of term/self-host/change/001-finish-self-host).
//
// Its own module, with no import, so a test reads it without running port-build's top level (which loads stage0).

export function shelvedText(text: string): boolean {
  return /^(mark|note) draft\s*$/m.test(text)
}
