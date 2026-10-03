// List, from Are We Fast Yet, written by hand as plain idiomatic TypeScript (ours, 2026-10-03): AWFY's own shape, a
// node whose `next` may be null, `makeList`, `isShorterThan` walking both, and the Takeuchi-style `tail`
class Element {
  constructor(
    public value: number,
    public next: Element | null,
  ) {}

  length(): number {
    return this.next === null ? 1 : 1 + this.next.length()
  }
}

function makeList(size: number): Element | null {
  return size === 0 ? null : new Element(size, makeList(size - 1))
}

function isShorterThan(x: Element | null, y: Element | null): boolean {
  let xTail = x
  let yTail = y

  while (yTail !== null) {
    if (xTail === null) {
      return true
    }

    xTail = xTail.next
    yTail = yTail.next
  }

  return false
}

function tail(x: Element | null, y: Element | null, z: Element | null): Element | null {
  if (isShorterThan(y, x)) {
    return tail(tail(x!.next, y, z), tail(y!.next, z, x), tail(z!.next, x, y))
  }

  return z
}

const n = Number(process.argv[2] ?? 2)
let total = 0

for (let round = 0; round < n; round++) {
  total += tail(makeList(15), makeList(10), makeList(6))!.length()
}

console.log(total)
