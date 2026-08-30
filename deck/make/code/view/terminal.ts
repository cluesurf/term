// A string-with-ANSI render target for zone components. The same fine-grained reactive graph (reactive.ts) drives
// it: a reactive cell re-renders only when its signals change. This shows zone is renderer-agnostic (the DOM is
// one target, the terminal is another). See note/research/vibe/computation/plans/15-components.md. Browser-safe.

import { effect } from '@term/make/code/zone/reactive'

export type Style = (text: string) => string

// ANSI styles (no-op-able: pass plain to disable)
export const ansi = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  plain: (s: string) => s,
}

// a node in the terminal view tree: a reactive text cell or a container
export type Cell =
  | { kind: 'text'; value: string; dispose: () => void }
  | { kind: 'group'; children: Cell[] }

// a reactive text cell: an effect recomputes its cached value only when its dependencies change (minimal update)
export function text(
  get: () => string,
  style: Style = ansi.plain,
): Cell {
  const cell: Cell = { kind: 'text', value: '', dispose: () => {} }
  cell.dispose = effect(() => {
    cell.value = style(get())
  })

  return cell
}

// a static string cell
export function still(value: string, style: Style = ansi.plain): Cell {
  return { kind: 'text', value: style(value), dispose: () => {} }
}

// a container of cells
export function group(children: Cell[]): Cell {
  return { kind: 'group', children }
}

// render the current state of the view to a string (reads cached cell values, no recompute)
export function render(cell: Cell): string {
  if (cell.kind === 'text') {
    return cell.value
  }

  return cell.children.map(render).join('')
}

// dispose every reactive cell in a view
export function dispose(cell: Cell): void {
  if (cell.kind === 'text') {
    cell.dispose()
  } else {
    for (const child of cell.children) {
      dispose(child)
    }
  }
}
