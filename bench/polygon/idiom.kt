// Polygon, ours, the same structure as term.tree, written by hand as plain idiomatic Kotlin (2026-10-03): 200 polygons
// a run, each a class holding its corners' coordinates, built fresh and then measured, the taxicab perimeters added
class Polygon(val sides: Int, val points: IntArray)

fun makePolygon(k: Int): Polygon {
    val sides = 3 + k % 13
    val points = IntArray(sides * 2)
    var x = k % 17
    var y = (k * 7) % 23

    for (c in 0 until sides) {
        points[c * 2] = x
        points[c * 2 + 1] = y
        x = (x + c + k) % 50
        y = (y + c * 3) % 50
    }

    return Polygon(sides, points)
}

fun perimeter(p: Polygon): Long {
    var total = 0L

    for (c in 0 until p.sides) {
        val next = (c + 1) % p.sides
        total += Math.abs(p.points[c * 2] - p.points[next * 2]) + Math.abs(p.points[c * 2 + 1] - p.points[next * 2 + 1])
    }

    return total
}

fun main(args: Array<String>) {
    val n = args.getOrNull(0)?.toInt() ?: 3
    var total = 0L

    repeat(n) {
        val shapes = List(200) { makePolygon(it) }

        for (p in shapes) {
            total += perimeter(p)
        }
    }

    println(total)
}
