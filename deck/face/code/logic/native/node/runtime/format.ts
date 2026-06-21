// Runtime shim for the `width-style` helper (SSR): splices a `width:<value>px` fragment between a branch's fixed style
// prefix and suffix, via the host String + string concat. Provided to Seed via <global:format> (docked `name format`, so
// this object IS the binding); the .tree side calls `format.widthStyle`. Identical to the browser shim -- the server
// render needs the same px strings for the width-dependent columns.
export const format = {
  widthStyle(before: string, value: number, after: string): string {
    return before + 'width:' + String(value) + 'px' + after
  },
}
