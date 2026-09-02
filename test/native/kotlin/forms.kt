// The forms a runtime shim expects from the emitted program. This file stands in for the emitted module: a shim
// is a source fragment the compiler prepends to emitted code and reads these out of that scope.
//
// They match what deck/make/code/compile/kotlin.ts emits for the matching `form` declarations. If the emitter
// changes shape, this is where the suite stops compiling, which is the point.
data class FileMetadata(
  var size: Long,
  var kind: String,
  var made: Long,
  var changed: Long,
  var opened: Long,
  var mode: Long,
  var link: Boolean,
)

data class WalkEntry(var path: String, var kind: String, var depth: Long)

data class WatchEvent(var kind: String, var path: String)

data class Header(var name: String, var value: String)

data class Request(
  var method: String,
  var url: String,
  var path: String,
  var query: String,
  var headers: MutableMap<String, String>,
  var body: String,
  var dock: Long,
)

data class Response(var status: Long, var headers: MutableList<Header>, var body: String)
