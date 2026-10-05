// Towers, from Are We Fast Yet, written by hand as plain idiomatic Kotlin (ours, 2026-10-03): AWFY's own shape, disk
// objects linked into three piles and relinked as they move, the moves counted in a field
class Disk(val size: Long) {
    var next: Disk? = null
}

class Towers {
    private val piles = arrayOfNulls<Disk>(3)
    var moves = 0L

    private fun pushDisk(disk: Disk, pile: Int) {
        val top = piles[pile]

        if (top != null && disk.size >= top.size) error("Cannot put a big disk onto a smaller one")

        disk.next = top
        piles[pile] = disk
    }

    private fun popDisk(pile: Int): Disk {
        val top = piles[pile] ?: error("Attempting to remove a disk from an empty pile")

        piles[pile] = top.next
        top.next = null

        return top
    }

    private fun moveTop(from: Int, to: Int) {
        pushDisk(popDisk(from), to)
        moves++
    }

    fun buildTower(pile: Int, disks: Int) {
        for (i in disks downTo 0) pushDisk(Disk(i.toLong()), pile)
    }

    fun moveDisks(disks: Int, from: Int, to: Int) {
        if (disks == 1) {
            moveTop(from, to)
        } else {
            val other = 3 - from - to
            moveDisks(disks - 1, from, other)
            moveTop(from, to)
            moveDisks(disks - 1, other, to)
        }
    }
}

fun main(args: Array<String>) {
    val n = args.firstOrNull()?.toIntOrNull() ?: 2
    var total = 0L

    repeat(n) {
        val towers = Towers()
        towers.buildTower(0, 13)
        towers.moveDisks(13, 0, 1)
        total += towers.moves
    }

    println(total)
}
