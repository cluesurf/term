// SQLite runtime for the kotlin database native in the `compose` env (compose-target): the desktop JVM, which has no
// android.database.sqlite, reaches SQLite through JDBC (the sqlite-jdbc driver Compose's build resolves). Found ahead of
// ../sqlite.kt, Android's, because the prelude tries `runtime/<env>/` first. The same API and the same answers as that
// one: one open database, rows as maps the `row` form carries as its opaque handle, every column read back as text.
// Provided to Term via <global:sqlite>. Reached only through the public `base/db` API.
//
// Placeholders: SQLite wants `?`, the node impl was written against Postgres's `$1`, and one query text should serve
// both, so `$n` is rewritten to `?` in order, as the Android runtime does.
object sqlite {
    private var database: java.sql.Connection? = null

    // `url` is a file path, or empty for a database that lives only as long as the process
    fun connect(url: String) {
        database = java.sql.DriverManager.getConnection(if (url.isEmpty()) "jdbc:sqlite::memory:" else "jdbc:sqlite:$url")
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

    private fun prepared(db: java.sql.Connection, sql: String, params: MutableList<Any>): java.sql.PreparedStatement {
        val statement = db.prepareStatement(rewrite(sql))
        params.forEachIndexed { index, value -> statement.setString(index + 1, value.toString()) }
        return statement
    }

    // every row as a map of column name to text, wrapped in the `row` form
    fun query(sql: String, params: MutableList<Any>): MutableList<Row> {
        val db = database ?: return mutableListOf()
        val rows = mutableListOf<Row>()
        prepared(db, sql, params).use { statement ->
            statement.executeQuery().use { result ->
                val columns = result.metaData
                while (result.next()) {
                    val record = LinkedHashMap<String, String>()
                    for (column in 1..columns.columnCount) {
                        record[columns.getColumnLabel(column)] = result.getString(column) ?: ""
                    }
                    rows.add(Row(record))
                }
            }
        }
        return rows
    }

    fun run(sql: String, params: MutableList<Any>) {
        val db = database ?: return
        prepared(db, sql, params).use { it.execute() }
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
