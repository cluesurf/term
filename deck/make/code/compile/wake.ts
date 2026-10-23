// What wakes the hive: the roll grouped by deck, the one shape compile.ts `wakeGroups` makes and every emitter's wake
// chain reads (emitTypeScript, emitRust, emitSwift, emitKotlin). A module of its own so the emitters import it with no
// cycle through compile.ts (term/hive decision 002). Browser-safe, no host APIs.

export type WakeEntry = Record<string, unknown>

export type WakeGroup = {
  deck: string
  entries: WakeEntry[]
  // the deck's static exception, tell and dock entries, for `hive-wake-typed`, which a backend writes as records of
  // `exception-roll`, `tell-roll` and `dock-roll` (seam spec §3.3)
  typed: { exceptions: WakeEntry[]; tells: WakeEntry[]; docks: WakeEntry[] }
}
