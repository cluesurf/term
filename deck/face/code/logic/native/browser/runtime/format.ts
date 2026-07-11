// Runtime shim for the `width-style` helper: splices a `width:<value>px` fragment between a branch's fixed style prefix
// and suffix, via the host String + string concat. Provided to Seed via <global:format> (docked `name format`, so this
// object IS the binding); the .tree side calls `format.widthStyle`. A namespace object (not a top-level function) so the
// bundled client has no name collisions. Identical on browser and node -- both targets get the same string assembly; the
// split exists only so the face logic native-env mechanism (browser / node) can resolve it per platform like the
// viewport module. Keeping the concat in TS keeps the numeric `add` builtin (typed number -> number by the .tree type
// checker) out of the string-building path.
export const format = {
  widthStyle(before: string, value: number, after: string): string {
    return before + 'width:' + String(value) + 'px' + after
  },

  // a numeric opacity as a plain string ("0", "0.7", "1"), for the inline `opacity` the text-visibility machine writes
  // per phase. Number -> text in the shim so the numeric `add` builtin stays out of the .tree string path. An absent
  // settled opacity (no `opacity` prop) coalesces to 1, matching React's `opacity ?? 1` (an explicit 0 is preserved).
  opacity(value: number): string {
    return String(value == null ? 1 : value)
  },

  // a transition-duration fragment ("200ms"), for the inline transition the text-visibility machine writes while a
  // fade is running.
  duration(value: number): string {
    return String(value) + 'ms'
  },

  // current high-resolution time in ms. The visibility machine measures its snap / fade / late-arrival windows against
  // this (and the family's first-ask stamp, taken the same way), so it needs a monotone clock, not the wall clock.
  now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now()
  },

  // the font class token for a family + suffix ("font-CrowMark", "font-CrowMark-fallback", "font-CrowMark-waiting").
  // Inner whitespace is stripped so a multi-word family maps to one token, matching React's buildFontClassName. In the
  // shim because the `add` builtin is numeric (string concat is not kernel-checked through it).
  fontClass(family: string, suffix: string): string {
    // No font -> no class, matching React's buildFontClassName (returns '' when there is no font).
    if (!family) {
      return ''
    }
    return 'font-' + family.replace(/\s+/g, '') + suffix
  },
}
