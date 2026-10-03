// Towers, from Are We Fast Yet, written by hand as plain idiomatic Swift (ours, 2026-10-03): AWFY's own shape, disk
// objects linked into three piles and relinked as they move, the moves counted in a field
final class Disk {
    let size: Int
    var next: Disk?

    init(_ size: Int) { self.size = size }
}

final class Towers {
    var piles: [Disk?] = [nil, nil, nil]
    var moves = 0

    func pushDisk(_ disk: Disk, _ pile: Int) {
        if let top = piles[pile], disk.size >= top.size {
            fatalError("Cannot put a big disk onto a smaller one")
        }

        disk.next = piles[pile]
        piles[pile] = disk
    }

    func popDisk(_ pile: Int) -> Disk {
        guard let top = piles[pile] else { fatalError("Attempting to remove a disk from an empty pile") }

        piles[pile] = top.next
        top.next = nil

        return top
    }

    func moveTop(_ from: Int, _ to: Int) {
        pushDisk(popDisk(from), to)
        moves += 1
    }

    func buildTower(_ pile: Int, _ disks: Int) {
        for i in stride(from: disks, through: 0, by: -1) {
            pushDisk(Disk(i), pile)
        }
    }

    func moveDisks(_ disks: Int, _ from: Int, _ to: Int) {
        if disks == 1 {
            moveTop(from, to)
        } else {
            let other = 3 - from - to
            moveDisks(disks - 1, from, other)
            moveTop(from, to)
            moveDisks(disks - 1, other, to)
        }
    }
}

let n = CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1]) ?? 2 : 2
var total = 0

for _ in 0..<n {
    let towers = Towers()
    towers.buildTower(0, 13)
    towers.moveDisks(13, 0, 1)
    total += towers.moves
}

print(total)
