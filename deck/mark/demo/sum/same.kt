// The sum of 1 to size, the same algorithm as term.tree: the numbers into a list, then folded.
fun main(args: Array<String>) {
    val size = args[0].toLong()
    val items = ArrayList<Long>()

    var i = 1L
    while (i < size + 1) {
        items.add(i)
        i += 1
    }

    val total = items.fold(0L) { sum, item -> sum + item }

    println(total)
}
