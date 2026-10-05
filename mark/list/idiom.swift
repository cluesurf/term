// List, from Are We Fast Yet, written by hand as plain idiomatic Swift (ours, 2026-10-03): AWFY's own shape, a node
// class whose `next` may be nil, `makeList`, `isShorterThan` walking both, and the Takeuchi-style `tail`
final class Element {
    let value: Int
    let next: Element?

    init(_ value: Int, _ next: Element?) {
        self.value = value
        self.next = next
    }

    func length() -> Int {
        next.map { 1 + $0.length() } ?? 1
    }
}

func makeList(_ size: Int) -> Element? {
    size == 0 ? nil : Element(size, makeList(size - 1))
}

func isShorterThan(_ x: Element?, _ y: Element?) -> Bool {
    var xTail = x
    var yTail = y

    while let y = yTail {
        guard let x = xTail else { return true }

        xTail = x.next
        yTail = y.next
    }

    return false
}

func tail(_ x: Element?, _ y: Element?, _ z: Element?) -> Element? {
    if isShorterThan(y, x) {
        return tail(tail(x!.next, y, z), tail(y!.next, z, x), tail(z!.next, x, y))
    }

    return z
}

let n = CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1]) ?? 2 : 2
var total = 0

for _ in 0..<n {
    total += tail(makeList(15), makeList(10), makeList(6))!.length()
}

print(total)
