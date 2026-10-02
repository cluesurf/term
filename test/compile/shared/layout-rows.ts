// The layout rows native-dom-0027 holds, and the ONE judge of them. test/compile/toolkit-view.ts reads their frames
// back from AppKit, UIKit and Android views and test/compile/layout-golden.ts from Chromium, and both judge them here,
// so the web and every platform are held to the same relationships: order, edges, which child grew, stretch, height.
// Never absolute pixels, which differ by platform for a button with the same label.
// A helper, not a suite: it sits under shared/, which the suite runner does not walk.

// four rows of two buttons each, as Term `view`s taking a host. The importing program loads `view` and the render
// runtime; a document `div` carrying `display: flex` is a stack on every host
export const LAYOUT_ROWS = `view spread-row
  take host, like view
  view div
    bind style, text <display: flex; flex-direction: row; width: 300px; justify-content: space-between>
    view button
      text <a>
    view button
      text <bb>

view grow-row
  take host, like view
  view div
    bind style, text <display: flex; flex-direction: row; width: 300px>
    view button
      bind style, text <flex-grow: 1>
      text <a>
    view button
      text <bb>

view stretch-column
  take host, like view
  view div
    bind style, text <display: flex; flex-direction: column; width: 200px; align-items: stretch>
    view button
      text <a>
    view button
      text <bb>

view tall-row
  take host, like view
  view div
    bind style, text <display: flex; flex-direction: row; height: 60px; align-items: center>
    view button
      text <a>
    view button
      text <bb>

view block-fill
  take host, like view
  view div
    bind style, text <width: 300px>
    view div
      view button
        text <a>
    view div
      view button
        text <bb>

view flex-default
  take host, like view
  view div
    bind style, text <display: flex>
    view button
      text <a>
    view button
      text <bb>

view column-default
  take host, like view
  view div
    bind style, text <display: flex; flex-direction: column; width: 200px>
    view button
      text <a>
    view button
      text <bb>
`

// the rows in the order a program mounts them, each with the view that draws it
export const LAYOUT_LABELS: [label: string, view: string][] = [
  ['spread', 'spread-row'],
  ['grow', 'grow-row'],
  ['stretch', 'stretch-column'],
  ['tall', 'tall-row'],
  ['block', 'block-fill'],
  ['flex', 'flex-default'],
  ['column', 'column-default'],
]

const near = (a: number, b: number) => Math.abs(a - b) <= 1

// the frames of one row out of a host's output: a line `rows <label> x,y,w,h x,y,w,h x,y,w,h`, the row then its children
function rowsOf(output: string, label: string): number[][] | undefined {
  const line = output.split('\n').map(l => l.trim()).find(l => l.includes(`rows ${label} `))
  const parts = line?.slice(line.indexOf(`rows ${label} `) + `rows ${label} `.length).split(' ')

  return parts?.length === 3 ? parts.map(part => part.split(',').map(Number)) : undefined
}

// every check, as [name, passed, the frames it read]
export function judgeLayout(output: string): [string, boolean, string][] {
  const spread = rowsOf(output, 'spread')
  const grow = rowsOf(output, 'grow')
  const stretch = rowsOf(output, 'stretch')
  const tall = rowsOf(output, 'tall')
  const block = rowsOf(output, 'block')
  const flex = rowsOf(output, 'flex')
  const column = rowsOf(output, 'column')

  return [
    // native-dom-0037: CSS's defaults, which every native host had the other way round
    [
      "a block container's block children fill its 300 width, one under the other",
      !!block && near(block[1]![2]!, 300) && near(block[2]![2]!, 300) && block[2]![1]! >= block[1]![1]! + block[1]![3]! - 1,
      JSON.stringify(block),
    ],
    [
      'display flex with no direction is a row',
      !!flex && near(flex[1]![1]!, flex[2]![1]!) && flex[2]![0]! >= flex[1]![0]! + flex[1]![2]! - 1,
      JSON.stringify(flex),
    ],
    [
      'a flex column with no align-items stretches its children to its 200 width',
      !!column && near(column[1]![2]!, 200) && near(column[2]![2]!, 200),
      JSON.stringify(column),
    ],
    [
      'width 300 and justify-content space-between put the children at both edges',
      !!spread && near(spread[0]![2]!, 300) && near(spread[1]![0]!, spread[0]![0]!) && near(spread[2]![0]! + spread[2]![2]!, spread[0]![0]! + 300),
      JSON.stringify(spread),
    ],
    [
      "flex-grow 1 takes the rest of a 300 row, the two adjacent as with CSS's zero gap",
      !!grow && near(grow[0]![2]!, 300) && grow[1]![2]! > grow[2]![2]! && near(grow[1]![2]! + grow[2]![2]!, 300) && near(grow[2]![0]!, grow[1]![0]! + grow[1]![2]!),
      JSON.stringify(grow),
    ],
    [
      'align-items stretch makes both children of a 200 column 200 wide',
      !!stretch && near(stretch[0]![2]!, 200) && near(stretch[1]![2]!, 200) && near(stretch[2]![2]!, 200),
      JSON.stringify(stretch),
    ],
    ["height 60 is the row's height", !!tall && near(tall[0]![3]!, 60), JSON.stringify(tall)],
  ]
}
