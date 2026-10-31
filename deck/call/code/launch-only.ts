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
]

const NAMES = new Set(LAUNCH_ONLY)

export function isLaunchOnly(name: string): boolean {
  return NAMES.has(name)
}
