// The swift native smoke suite: the SHIPPED runtime shims, compiled and RUN against NIOFileSystem and
// Hummingbird.
//
// The native gate proves every module typechecks. It never runs a line. This does. If a shim typechecks but does
// the wrong thing, this is what says so.
//
// `task/term/native/swift.sh test` assembles this with the shim sources into a SwiftPM package and runs it.
// SwiftPM will not take sources from outside a target's directory, which is why the assembly is in the script
// rather than in a checked-in Package.swift.
import Foundation

var ran = 0
var failed = 0

func check(_ what: String, _ ok: Bool) {
  ran += 1

  if !ok {
    failed += 1
  }

  print("\(ok ? "ok  " : "FAIL")  \(what)")
}

func same<T: Equatable>(_ what: String, _ got: T, _ want: T) {
  check(got == want ? what : "\(what): got \(got), want \(want)", got == want)
}

func files() async {
  let root = await aio.temporaryMake("directory", "term-suite-", "")
  check("temporary directory made", !root.isEmpty)

  let one = "\(root)/one.txt"

  await aio.fileWrite(one, "hello")
  same("write then read", await aio.fileRead(one), "hello")

  await aio.fileAppend(one, " world")
  same("append", await aio.fileRead(one), "hello world")

  same("read bytes", await aio.fileReadBytes(one), Data("hello world".utf8))

  check("test with no kind", await aio.fileTest(one, ""))
  check("test file", await aio.fileTest(one, "file"))
  check("test directory is false on a file", !(await aio.fileTest(one, "directory")))
  check("test on a missing path", !(await aio.fileTest("\(root)/nope", "")))

  let meta = await stat.metaRead(one, true)
  same("metadata size", meta.size, 11)
  same("metadata kind", meta.kind, "file")
  check("metadata mode is set", meta.mode != 0)
  check("metadata changed is set", meta.changed > 0)

  let two = "\(root)/two.txt"
  await aio.fileCopy(one, two, false)
  same("copy", await aio.fileRead(two), "hello world")

  let three = "\(root)/three.txt"
  await aio.fileMove(two, three)
  check("move took the source away", !(await aio.fileTest(two, "")))
  same("move put it at the target", await aio.fileRead(three), "hello world")

  await aio.fileRemove(three, false)
  check("remove", !(await aio.fileTest(three, "")))

  let link = "\(root)/link.txt"
  await aio.linkMake(one, link, false)
  check("symbolic link is a link", await aio.fileTest(link, "link"))
  same("link read", await aio.linkRead(link), one)

  await aio.permissionWrite(one, 0o644)
  same("permission round trip", await aio.permissionRead(one) & 0o777, 0o644)

  check("owner user", await aio.ownerUser(one) >= 0)
  check("owner group", await aio.ownerGroup(one) >= 0)

  let handle = await aio.handleOpen(one, true, true, false, false, false)
  same("handle read from the start", await aio.handleRead(handle, 5), "hello")
  await aio.handleSeek(handle, 6, "start")
  same("handle read after seek", await aio.handleRead(handle, 5), "world")
  await aio.handleSeek(handle, 0, "start")
  same("handle write", await aio.handleWrite(handle, "HELLO"), 5)
  await aio.handleFlush(handle)
  await aio.handleClose(handle)
  same("handle write landed", await aio.fileRead(one), "HELLO world")

  let cut = await aio.handleOpen(one, true, true, false, false, false)
  await aio.handleClear(cut, 5)
  await aio.handleClose(cut)
  same("handle clear", await aio.fileRead(one), "HELLO")

  let big = "\(root)/big.txt"
  let writer = await aio.writerOpen(big, false)
  await aio.writerPush(writer, "one ")
  await aio.writerPush(writer, "two ")
  await aio.writerPush(writer, "three")
  await aio.writerClose(writer)
  same("write stream", await aio.fileRead(big), "one two three")

  let reader = await aio.readerOpen(big, 4, 3)
  same("read stream window", await aio.readerNext(reader), "two")
  same("read stream end", await aio.readerNext(reader), "")
  await aio.readerClose(reader)

  let nest = "\(root)/a/b"
  await walkFile.dirMake(nest)
  check("nested make", await aio.fileTest(nest, "directory"))
  await aio.fileWrite("\(nest)/deep.txt", "deep")

  let shallow = await walkFile.dirList(root, false)
  check("list is one level", shallow.contains("a"))
  check("list is one level, not more", !shallow.contains(where: { $0.contains("/") }))

  let deep = await walkFile.dirList(root, true)
  check("deep list reaches down", deep.contains("a/b/deep.txt"))

  let entries = await walkFile.dirWalk(root, 0)
  check("walk names a directory", entries.contains(where: { $0.kind == "directory" }))
  check("walk carries depth", entries.contains(where: { $0.depth > 0 }))

  let bounded = await walkFile.dirWalk(root, 1)
  check("walk depth 1 stops at one level", bounded.allSatisfy({ $0.depth == 0 }))

  let copy = "\(root)-copy"
  await aio.fileCopy(root, copy, true)
  check("deep copy reached the leaf", await aio.fileTest("\(copy)/a/b/deep.txt", ""))
  await aio.fileRemove(copy, true)
  check("deep remove", !(await aio.fileTest(copy, "")))

  // watching: kqueue reports that the WATCHED path changed, so the watch is on the file itself
  let watched = "\(root)/watched.txt"
  await aio.fileWrite(watched, "before")
  let watcher = await watchFile.watchOpen(watched, false)
  let seen = Task { await watchFile.watchNext(watcher) }
  try? await Task.sleep(nanoseconds: 300_000_000)
  await aio.fileWrite(watched, "after")

  let raced = Task {
    try? await Task.sleep(nanoseconds: 5_000_000_000)
    await watchFile.watchClose(watcher)
  }
  let event = await seen.value
  raced.cancel()
  check("watch saw a change (\(event.kind))", !event.kind.isEmpty)

  await watchFile.watchClose(watcher)
  same("watch after close is the empty event", await watchFile.watchNext(watcher).kind, "")

  await aio.fileRemove(root, true)
}

func server() async {
  let port = 18_431

  let handler: (Request) -> Response = { request in
    Response(
      status: 201,
      headers: SeedList([
        Header(name: "content-type", value: "text/plain"),
        Header(name: "set-cookie", value: "one=1"),
        Header(name: "set-cookie", value: "two=2"),
      ]),
      body:
        "\(request.method) \(request.path) q=\(request.query) agent=\(request.headers.data["x-agent"] ?? "") body=\(request.body)"
    )
  }

  let running = await runtime.start(port, "127.0.0.1", handler, false, "", "")
  try? await Task.sleep(nanoseconds: 700_000_000)

  // a body far larger than one packet, which is exactly what the old hand-rolled loop truncated
  let payload = String(repeating: "x", count: 40_000)
  let answer = await fetch(port, payload)

  same("server status", answer.status, 201)
  check("server read the whole body", answer.body.hasSuffix("body=\(payload)"))
  check("server read the path", answer.body.contains("POST /hello"))
  check("server read the query", answer.body.contains("q=a=1&b=2"))
  check("server read a request header", answer.body.contains("agent=suite"))
  check(
    "server sent content-type",
    answer.headers.contains(where: { $0.hasPrefix("content-type: text/plain") })
  )
  same(
    "server kept BOTH set-cookie headers",
    answer.headers.filter({ $0.hasPrefix("set-cookie:") }).count,
    2
  )

  await runtime.stop(running)
}

// a raw HTTP/1.1 request, so the suite tests the server rather than a client library
func fetch(
  _ port: Int,
  _ payload: String
) async -> (status: Int, headers: [String], body: String) {
  let request =
    "POST /hello?a=1&b=2 HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Agent: suite\r\nContent-Length: \(payload.utf8.count)\r\nConnection: close\r\n\r\n\(payload)"

  var input: InputStream?
  var output: OutputStream?
  Stream.getStreamsToHost(
    withName: "127.0.0.1",
    port: port,
    inputStream: &input,
    outputStream: &output
  )

  guard let input, let output else { return (0, [], "") }

  input.open()
  output.open()

  let bytes = Array(request.utf8)
  var sent = 0

  while sent < bytes.count {
    let wrote = bytes[sent...].withUnsafeBufferPointer { buffer in
      output.write(buffer.baseAddress!, maxLength: buffer.count)
    }

    if wrote <= 0 { break }

    sent += wrote
  }

  var whole = Data()
  var buffer = [UInt8](repeating: 0, count: 65536)

  while true {
    let read = input.read(&buffer, maxLength: buffer.count)

    if read <= 0 { break }

    whole.append(contentsOf: buffer[0..<read])
  }

  input.close()
  output.close()

  let text = String(decoding: whole, as: UTF8.self)

  guard let split = text.range(of: "\r\n\r\n") else { return (0, [], "") }

  let head = String(text[..<split.lowerBound])
  let body = String(text[split.upperBound...])
  var lines = head.components(separatedBy: "\r\n")
  let first = lines.isEmpty ? "" : lines.removeFirst()
  let status = Int(first.split(separator: " ").dropFirst().first.map(String.init) ?? "0") ?? 0

  return (status, lines.map { $0.lowercased() }, body)
}

print("-- asynchronous files (NIOFileSystem)")
await files()
print("-- http server (Hummingbird)")
await server()

print("\nswift native suite: \(ran) checks, \(failed) failed")

if failed > 0 {
  exit(1)
}
