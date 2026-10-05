// The sum of 1 to size, the same algorithm as term.tree: the numbers into an array, then folded.
const size = Number(process.argv[2])
const items: number[] = []

for (let i = 1; i < size + 1; i++) {
  items.push(i)
}

const total = items.reduce((sum, item) => sum + item, 0)

console.log(String(total))
