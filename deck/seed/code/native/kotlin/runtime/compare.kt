// Deep structural equality over Any: scalar equality, two lists element by element, else false. Kotlin's
// == already deep-compares lists of scalars; the recursion covers lists of dynamics.
object compareRuntime {
    fun deepEqual(a: Any?, b: Any?): Boolean {
        if (a == b) return true

        if (a is List<*> && b is List<*>) {
            if (a.size != b.size) return false

            for (i in a.indices) {
                if (!deepEqual(a[i], b[i])) return false
            }

            return true
        }

        return false
    }

    fun numeric(v: Any?): Double = when (v) {
        is Long -> v.toDouble()
        is Int -> v.toDouble()
        is Double -> v
        else -> Double.NaN
    }

    fun contains(list: Any?, value: Any?): Boolean {
        if (list !is List<*>) return false

        return list.any { deepEqual(it, value) }
    }

    fun asText(v: Any?): String = (v as? String) ?: ""

    fun isTruthy(v: Any?): Boolean = when (v) {
        null, Unit -> false
        is Boolean -> v
        is Long -> v != 0L
        is Double -> v != 0.0
        is String -> v.isNotEmpty()
        else -> true
    }

    fun above(a: Any?, b: Any?): Boolean = numeric(a) > numeric(b)

    fun below(a: Any?, b: Any?): Boolean = numeric(a) < numeric(b)

    fun gap(a: Any?, b: Any?): Double = Math.abs(numeric(a) - numeric(b))
}
