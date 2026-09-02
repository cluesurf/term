// SQLite runtime for the swift database native: one open connection, queries over the system SQLite3 library, rows
// as dictionaries the `row` form carries as its opaque handle. Provided to Term via <global:sqlite>. Reached only
// through the public `base/db` API.
//
// Placeholders: SQLite wants `?`, the node impl was written against Postgres's `$1`, and one query text should
// serve both, so `$n` is rewritten to `?` in order. Values bind as text, integer, double or null by their Swift type;
// every column reads back as text through `field`, the way the Postgres shim answers.
import Foundation
import SQLite3

// the destructor SQLite wants for a bound text it must copy
private let SQLITE_TRANSIENT_COPY = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

enum sqlite {
    private static var connection: OpaquePointer?

    // `url` is a file path, or empty for a database that lives only as long as the process
    static func connect(_ url: String) {
        var handle: OpaquePointer?
        let path = url.isEmpty ? ":memory:" : url
        if sqlite3_open(path, &handle) == SQLITE_OK {
            connection = handle
        } else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "sqlite3_open failed"
            print("sqlite: \(message)")
        }
    }

    // `$1`, `$2` to `?`: SQLite binds positional `?` in order, which is the order the `$n` were numbered
    private static func rewrite(_ sql: String) -> String {
        var out = sql
        var n = 1
        while out.contains("$\(n)") {
            out = out.replacingOccurrences(of: "$\(n)", with: "?")
            n += 1
        }
        return out
    }

    private static func prepare(_ sql: String, _ params: SeedList<Any>) -> OpaquePointer? {
        guard let connection = connection else {
            print("sqlite: no connection. Call connect first")
            return nil
        }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(connection, rewrite(sql), -1, &statement, nil) == SQLITE_OK, let ready = statement else {
            print("sqlite: \(String(cString: sqlite3_errmsg(connection))) in \(sql)")
            return nil
        }
        for (index, value) in params.data.enumerated() {
            let slot = Int32(index + 1)
            switch value {
            case let text as String:
                sqlite3_bind_text(ready, slot, text, -1, SQLITE_TRANSIENT_COPY)
            case let number as Int:
                sqlite3_bind_int64(ready, slot, Int64(number))
            case let number as Double:
                sqlite3_bind_double(ready, slot, number)
            case let flag as Bool:
                sqlite3_bind_int(ready, slot, flag ? 1 : 0)
            default:
                sqlite3_bind_null(ready, slot)
            }
        }
        return ready
    }

    // every row as a dictionary of column name to text, wrapped in the `row` form
    static func query(_ sql: String, _ params: SeedList<Any>) -> [Row] {
        guard let statement = prepare(sql, params) else { return [] }
        defer { sqlite3_finalize(statement) }
        var rows: [Row] = []
        let count = sqlite3_column_count(statement)
        while sqlite3_step(statement) == SQLITE_ROW {
            var record: [String: String] = [:]
            for column in 0..<count {
                let name = String(cString: sqlite3_column_name(statement, column))
                if let text = sqlite3_column_text(statement, column) {
                    record[name] = String(cString: text)
                } else {
                    record[name] = ""
                }
            }
            rows.append(Row(handle: record))
        }
        return rows
    }

    static func run(_ sql: String, _ params: SeedList<Any>) {
        guard let statement = prepare(sql, params) else { return }
        defer { sqlite3_finalize(statement) }
        let outcome = sqlite3_step(statement)
        if outcome != SQLITE_DONE && outcome != SQLITE_ROW, let connection = connection {
            print("sqlite: \(String(cString: sqlite3_errmsg(connection))) in \(sql)")
        }
    }

    static func field(_ row: Row, _ name: String) -> String {
        return (row.handle as? [String: String])?[name] ?? ""
    }

    static func close() {
        if let connection = connection {
            sqlite3_close(connection)
        }
        connection = nil
    }
}
