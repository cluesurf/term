// The sum of 1 to size, the same algorithm as term.tree: the numbers into an array, then folded.
let size = Int(CommandLine.arguments[1])!
var items: [Int] = []

for i in 1..<(size + 1) {
  items.append(i)
}

let total = items.reduce(0) { sum, item in sum + item }

print(total)
