// The forms a runtime shim expects from the emitted program. This file stands in for the emitted module: a shim
// is a source fragment the compiler prepends to emitted code and reads these out of that scope.
//
// They match what deck/make/code/compile/swift.ts emits for the matching `form` declarations. If the emitter
// changes shape, this is where the suite stops compiling, which is the point.
final class SeedMap<K: Hashable, V> {
  var data: [K: V]
  init(_ data: [K: V]) { self.data = data }
}

final class SeedList<T> {
  var data: [T]
  init(_ data: [T]) { self.data = data }
}

struct FileMetadata {
  var size: Int
  var kind: String
  var made: Int
  var changed: Int
  var opened: Int
  var mode: Int
  var link: Bool
}

struct WalkEntry {
  var path: String
  var kind: String
  var depth: Int
}

struct WatchEvent {
  var kind: String
  var path: String
}

struct Header {
  var name: String
  var value: String
}

struct Request {
  var method: String
  var url: String
  var path: String
  var query: String
  var headers: SeedMap<String, String>
  var body: String
  var dock: Int
}

struct Response {
  var status: Int
  var headers: SeedList<Header>
  var body: String
}
