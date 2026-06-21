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
}
