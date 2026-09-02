// SQLite runtime for the kotlin database native, over Android's own android.database.sqlite: one open database,
// rows as maps the `row` form carries as its opaque handle. Provided to Term via <global:sqlite>. Reached only
// through the public `base/db` API.
//
// Placeholders: SQLite wants `?`, the node impl was written against Postgres's `$1`, and one query text should
// serve both, so `$n` is rewritten to `?` in order. Every column reads back as text through `field`, the way the
// Postgres shim answers. The cask sets the context before `connect` runs, since a database file lives in the app's
// own files directory.
import android.database.sqlite.SQLiteDatabase

object sqlite {
    private var database: SQLiteDatabase? = null

    // `url` is a file path, or empty for a database that lives only as long as the process
    fun connect(url: String) {
        database = if (url.isEmpty()) SQLiteDatabase.create(null) else SQLiteDatabase.openOrCreateDatabase(url, null)
    }

    private fun rewrite(sql: String): String {
        var out = sql
        var n = 1
        while (out.contains("$$n")) {
            out = out.replace("$$n", "?")
            n += 1
        }
        return out
    }

    // every row as a map of column name to text, wrapped in the `row` form
    fun query(sql: String, params: MutableList<Any>): MutableList<Row> {
        val db = database ?: return mutableListOf()
        val rows = mutableListOf<Row>()
        val arguments = params.map { it.toString() }.toTypedArray()
        db.rawQuery(rewrite(sql), arguments).use { cursor ->
            while (cursor.moveToNext()) {
                val record = LinkedHashMap<String, String>()
                for (column in 0 until cursor.columnCount) {
                    record[cursor.getColumnName(column)] = if (cursor.isNull(column)) "" else cursor.getString(column)
                }
                rows.add(Row(record))
            }
        }
        return rows
    }

    fun run(sql: String, params: MutableList<Any>) {
        val db = database ?: return
        db.execSQL(rewrite(sql), params.toTypedArray())
    }

    fun field(row: Row, name: String): String {
        @Suppress("UNCHECKED_CAST")
        return (row.handle as? Map<String, String>)?.get(name) ?: ""
    }

    fun close() {
        database?.close()
        database = null
    }
}
