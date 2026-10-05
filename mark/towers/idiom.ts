// Towers, from Are We Fast Yet, written by hand as plain idiomatic TypeScript (ours, 2026-10-03): AWFY's own shape,
// disk objects linked into three piles and relinked as they move, the moves counted in a field
class Disk {
  next: Disk | null = null

  constructor(public size: number) {}
}

class Towers {
  piles: (Disk | null)[] = [null, null, null]
  moves = 0

  pushDisk(disk: Disk, pile: number): void {
    const top = this.piles[pile]!

    if (top && disk.size >= top.size) {
      throw new Error('Cannot put a big disk onto a smaller one')
    }

    disk.next = top
    this.piles[pile] = disk
  }

  popDisk(pile: number): Disk {
    const top = this.piles[pile]

    if (!top) {
      throw new Error('Attempting to remove a disk from an empty pile')
    }

    this.piles[pile] = top.next
    top.next = null

    return top
  }

  moveTop(from: number, to: number): void {
    this.pushDisk(this.popDisk(from), to)
    this.moves++
  }

  buildTower(pile: number, disks: number): void {
    for (let i = disks; i >= 0; i--) {
      this.pushDisk(new Disk(i), pile)
    }
  }

  moveDisks(disks: number, from: number, to: number): void {
    if (disks === 1) {
      this.moveTop(from, to)
    } else {
      const other = 3 - from - to
      this.moveDisks(disks - 1, from, other)
      this.moveTop(from, to)
      this.moveDisks(disks - 1, other, to)
    }
  }
}

const n = Number(process.argv[2] ?? 2)
let total = 0

for (let round = 0; round < n; round++) {
  const towers = new Towers()
  towers.buildTower(0, 13)
  towers.moveDisks(13, 0, 1)
  total += towers.moves
}

console.log(total)
