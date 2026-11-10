// The environment variables that say only HOW a process was started, never what a build makes. Every key of a build
// over the environment leaves them out: task/port-build.ts's compiler fingerprint and work/build/build-graph.tree's
// env-text, which keys the persisted graph snapshot. One list, so the two cannot drift (item term-self-host-001-0476).
// Each of them in a key made the same tree a full rebuild, or a refused snapshot, from another route or terminal:
//
//   TERM_LINE_LOCK, TERM_LINE_LOCK_BY   who holds the line lock. make:line hands down a fresh random token every run
//                                       (traps.md T-0018b)
//   TERM_PROGRAM, TERM_PROGRAM_VERSION, TERM_SESSION_ID, TERM_FEATURES
//                                       the terminal emulator's own (iTerm2, Apple Terminal, VS Code), no Term variable.
//                                       TERM_SESSION_ID differs in every pane (item term-self-host-001-0453)
//   TERM_DEPTH                          how deep the console's runs nest: output.ts openRun sets it for every child of
//                                       a Term run, and term make reads its snapshot before its run opens (T-0457)
//   NODE_PATH                           pnpm's lookup path for the tsx it ran, which differs by where it was started
//                                       from (item term-self-host-001-0453)
//   TERM_CENSUS_KEEP, TERM_SUITE        a census run keeps every program it builds, named for its suite
//                                       (task/term/census-keep.cjs, item term-self-host-001-0508); the build is the same
//
// Plain TypeScript with no imports: port-build loads it before any port exists, and the build-graph port docks it.

export const LAUNCH_ONLY: readonly string[] = [
  'TERM_LINE_LOCK',
  'TERM_LINE_LOCK_BY',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TERM_SESSION_ID',
  'TERM_FEATURES',
  'TERM_DEPTH',
  'NODE_PATH',
  'TERM_CENSUS_KEEP',
  'TERM_SUITE',
]

const NAMES = new Set(LAUNCH_ONLY)

export function isLaunchOnly(name: string): boolean {
  return NAMES.has(name)
}

// PART of a variable can be launch-only too. NODE_OPTIONS stays in a key, since a flag in it can change what a compile
// does (`--conditions` picks other package exports, `--import` and `--require` run code first, `--stack-size` moves
// where a deep compile overflows), but its V8 heap sizes are left out: `--max-old-space-size` and
// `--max-semi-space-size` say only how much memory the process may use, and a compile that fits writes the same bytes.
// A queue check run under a heap cap made port-build a full rebuild, and the next make:line another (traps.md T-1015,
// item term-self-host-001-1017). `--expose-gc` stays: nothing has shown that no compile reads `gc`.
//
// Answers the text a key holds for the variable, or undefined when nothing of it is left. A value holding a quote is
// kept whole, since its words cannot be split safely on spaces. Only the `=<n>` spelling is a heap flag here: node
// refuses `--max-old-space-size 6144` in NODE_OPTIONS before any script runs, so no build ever sees that one.

const HEAP_FLAG = /^--max[-_](old|semi)[-_]space[-_]size=\d+$/

export function buildValue({ name, value }: { name: string; value: string }): string | undefined {
  if (name !== 'NODE_OPTIONS' || /["']/.test(value)) {
    return value
  }

  const kept = value.split(/\s+/).filter((word) => word !== '' && !HEAP_FLAG.test(word))

  return kept.length === 0 ? undefined : kept.join(' ')
}
