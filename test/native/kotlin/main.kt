// The kotlin native smoke suite: the SHIPPED runtime shims, compiled and RUN against java.nio on Dispatchers.IO
// and Ktor.
//
// The native gate proves every module compiles. It never runs a line. This does. If a shim compiles but does the
// wrong thing, this is what says so.
//
// Run it with `pnpm term:kotlin test`.
import java.net.Socket
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.delay
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withTimeoutOrNull

var ran = 0
var failed = 0

fun check(what: String, ok: Boolean) {
  ran += 1

  if (!ok) {
    failed += 1
  }

  println("${if (ok) "ok  " else "FAIL"}  $what")
}

fun <T> same(what: String, got: T, want: T) {
  val ok = got == want
  check(if (ok) what else "$what: got $got, want $want", ok)
}

suspend fun files() {
  val root = aio.temporaryMake("directory", "term-suite-", "")
  check("temporary directory made", root.isNotEmpty())

  val one = "$root/one.txt"

  aio.fileWrite(one, "hello")
  same("write then read", aio.fileRead(one), "hello")

  aio.fileAppend(one, " world")
  same("append", aio.fileRead(one), "hello world")

  same("read bytes", aio.fileReadBytes(one).toList(), "hello world".toByteArray().toList())

  check("test with no kind", aio.fileTest(one, ""))
  check("test file", aio.fileTest(one, "file"))
  check("test directory is false on a file", !aio.fileTest(one, "directory"))
  check("test on a missing path", !aio.fileTest("$root/nope", ""))

  val meta = stat.metaRead(one, true)
  same("metadata size", meta.size, 11L)
  same("metadata kind", meta.kind, "file")
  check("metadata mode is set", meta.mode != 0L)
  check("metadata changed is set", meta.changed > 0L)

  val two = "$root/two.txt"
  aio.fileCopy(one, two, false)
  same("copy", aio.fileRead(two), "hello world")

  val three = "$root/three.txt"
  aio.fileMove(two, three)
  check("move took the source away", !aio.fileTest(two, ""))
  same("move put it at the target", aio.fileRead(three), "hello world")

  aio.fileRemove(three, false)
  check("remove", !aio.fileTest(three, ""))

  val link = "$root/link.txt"
  aio.linkMake(one, link, false)
  check("symbolic link is a link", aio.fileTest(link, "link"))
  same("link read", aio.linkRead(link), one)

  aio.permissionWrite(one, 420L)
  same("permission round trip", aio.permissionRead(one) and 511L, 420L)

  check("owner user", aio.ownerUser(one) >= 0L)
  check("owner group", aio.ownerGroup(one) >= 0L)

  val handle = aio.handleOpen(one, true, true, false, false, false)
  same("handle read from the start", aio.handleRead(handle, 5L), "hello")
  aio.handleSeek(handle, 6L, "start")
  same("handle read after seek", aio.handleRead(handle, 5L), "world")
  aio.handleSeek(handle, 0L, "start")
  same("handle write", aio.handleWrite(handle, "HELLO"), 5L)
  aio.handleFlush(handle)
  aio.handleClose(handle)
  same("handle write landed", aio.fileRead(one), "HELLO world")

  val cut = aio.handleOpen(one, true, true, false, false, false)
  aio.handleClear(cut, 5L)
  aio.handleClose(cut)
  same("handle clear", aio.fileRead(one), "HELLO")

  val big = "$root/big.txt"
  val writer = aio.writerOpen(big, false)
  aio.writerPush(writer, "one ")
  aio.writerPush(writer, "two ")
  aio.writerPush(writer, "three")
  aio.writerClose(writer)
  same("write stream", aio.fileRead(big), "one two three")

  val reader = aio.readerOpen(big, 4L, 3L)
  same("read stream window", aio.readerNext(reader), "two")
  same("read stream end", aio.readerNext(reader), "")
  aio.readerClose(reader)

  val nest = "$root/a/b"
  walkFile.dirMake(nest)
  check("nested make", aio.fileTest(nest, "directory"))
  aio.fileWrite("$nest/deep.txt", "deep")

  val shallow = walkFile.dirList(root, false)
  check("list is one level", shallow.contains("a"))
  check("list is one level, not more", shallow.none { it.contains("/") })

  val deep = walkFile.dirList(root, true)
  check("deep list reaches down", deep.contains("a/b/deep.txt"))

  val entries = walkFile.dirWalk(root, 0L)
  check("walk names a directory", entries.any { it.kind == "directory" })
  check("walk carries depth", entries.any { it.depth > 0L })

  val bounded = walkFile.dirWalk(root, 1L)
  check("walk depth 1 stops at one level", bounded.all { it.depth == 0L })

  val copy = "$root-copy"
  aio.fileCopy(root, copy, true)
  check("deep copy reached the leaf", aio.fileTest("$copy/a/b/deep.txt", ""))
  aio.fileRemove(copy, true)
  check("deep remove", !aio.fileTest(copy, ""))

  // watching: WatchService registers a DIRECTORY, so the watch is on the directory and the event names the file
  val watchRoot = "$root/eye"
  walkFile.dirMake(watchRoot)
  val watcher = watchFile.watchOpen(watchRoot, false)

  coroutineScope {
    val seen = async { withTimeoutOrNull(8000L) { watchFile.watchNext(watcher) } }
    delay(500L)
    aio.fileWrite("$watchRoot/watched.txt", "changed")
    val event = seen.await()
    check("watch saw a change (${event?.kind})", event != null && event.kind.isNotEmpty())
  }

  watchFile.watchClose(watcher)
  same("watch after close is the empty event", watchFile.watchNext(watcher).kind, "")

  aio.fileRemove(root, true)
}

suspend fun server() {
  val port = 18432L

  val handler: (Request) -> Response = { request ->
    Response(
      201L,
      mutableListOf(
        Header("content-type", "text/plain"),
        Header("set-cookie", "one=1"),
        Header("set-cookie", "two=2"),
      ),
      "${request.method} ${request.path} q=${request.query} agent=${request.headers["x-agent"] ?: ""} body=${request.body}",
    )
  }

  val running = runtime.start(port, "127.0.0.1", handler, false, "", "")
  delay(1500L)

  // a body far larger than one packet, which is exactly what the old thread-per-request shim never had to handle
  val payload = "x".repeat(40000)
  val answer = fetch(port.toInt(), payload)

  same("server status", answer.first, 201)
  check("server read the whole body", answer.third.endsWith("body=$payload"))
  check("server read the path", answer.third.contains("POST /hello"))
  check("server read the query", answer.third.contains("q=a=1&b=2"))
  check("server read a request header", answer.third.contains("agent=suite"))
  check("server sent content-type", answer.second.any { it.startsWith("content-type: text/plain") })
  same(
    "server kept BOTH set-cookie headers",
    answer.second.count { it.startsWith("set-cookie:") },
    2,
  )

  runtime.stop(running)
}

// a raw HTTP/1.1 request, so the suite tests the server rather than a client library
fun fetch(port: Int, payload: String): Triple<Int, List<String>, String> {
  Socket("127.0.0.1", port).use { socket ->
    val request =
      "POST /hello?a=1&b=2 HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Agent: suite\r\n" +
        "Content-Length: ${payload.toByteArray().size}\r\nConnection: close\r\n\r\n$payload"
    socket.getOutputStream().write(request.toByteArray())
    socket.getOutputStream().flush()

    val text = socket.getInputStream().readBytes().toString(Charsets.UTF_8)
    val split = text.indexOf("\r\n\r\n")

    if (split < 0) return Triple(0, emptyList(), "")

    val head = text.substring(0, split).split("\r\n")
    val body = text.substring(split + 4)
    val status = head.firstOrNull()?.split(" ")?.getOrNull(1)?.toIntOrNull() ?: 0

    return Triple(status, head.drop(1).map { it.lowercase() }, body)
  }
}

// HTTP/2 cleartext, checked with curl rather than a client of our own: curl links nghttp2 and
// `--http2-prior-knowledge` speaks h2c, so this proves the server against an INDEPENDENT implementation. The
// `%{http_version}` write-out is the part that matters: a server that quietly answered HTTP/1.1 would pass every
// other assertion here.
suspend fun http2Server() {
  val port = 18532L

  val handler: (Request) -> Response = { request ->
    Response(
      200L,
      mutableListOf(Header("content-type", "text/plain")),
      "${request.path} scheme=${request.headers[":scheme"] ?: ""} stream=${request.headers["x-term-stream"] ?: ""}",
    )
  }

  val running = http2.start(port, "127.0.0.1", handler, false, "", "")
  // Netty's first boot in a JVM is class-loading heavy and takes seconds, not milliseconds. CIO above needs
  // 1.5s; this one needs more, and a short wait here reads as `version=0`, which is curl saying it never
  // connected rather than the server answering the wrong protocol.
  delay(6000L)

  val said =
    ProcessBuilder(
        "curl",
        "--http2-prior-knowledge",
        "--silent",
        "--max-time",
        "10",
        "--write-out",
        "|version=%{http_version}",
        "http://127.0.0.1:$port/h2/path",
      )
      .redirectErrorStream(false)
      .start()
      .let { proc ->
        val out = proc.inputStream.readBytes().toString(Charsets.UTF_8)
        proc.waitFor()
        out
      }

  check("http2 answered over h2c (${said.trim()})", said.contains("/h2/path"))
  check("http2 negotiated HTTP/2, not 1.1", said.contains("|version=2"))
  check("http2 filled the :scheme pseudo-header", said.contains("scheme=http"))

  http2.stop(running)
}

fun main() = runBlocking {
  println("-- asynchronous files (java.nio on Dispatchers.IO)")
  files()
  println("-- http server (Ktor CIO)")
  server()
  println("-- http2 server (Ktor Netty, h2c)")
  http2Server()

  println("\nkotlin native suite: $ran checks, $failed failed")

  if (failed > 0) {
    kotlin.system.exitProcess(1)
  }
}
