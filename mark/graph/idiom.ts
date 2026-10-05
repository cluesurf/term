// Graph, ours, the same structure as term.tree, written by hand as plain idiomatic TypeScript (2026-10-03): a grid's
// adjacency lists built fresh each run and searched breadth-first from the corner, the distances added
function neighbors(side: number): number[][] {
  const cells: number[][] = []

  for (let at = 0; at < side * side; at++) {
    const row = Math.floor(at / side)
    const column = at % side
    const near: number[] = []

    if (row > 0) near.push(at - side)
    if (column > 0) near.push(at - 1)
    if (column < side - 1) near.push(at + 1)
    if (row < side - 1) near.push(at + side)

    cells.push(near)
  }

  return cells
}

function search(cells: number[][]): number {
  const distance = new Array<number>(cells.length).fill(-1)
  const queue = [0]
  distance[0] = 0
  let total = 0

  for (let head = 0; head < queue.length; head++) {
    const at = queue[head]!
    const here = distance[at]!
    total += here

    for (const next of cells[at]!) {
      if (distance[next] === -1) {
        distance[next] = here + 1
        queue.push(next)
      }
    }
  }

  return total
}

const n = Number(process.argv[2] ?? 3)
let total = 0

for (let round = 0; round < n; round++) {
  total += search(neighbors(40))
}

console.log(total)
