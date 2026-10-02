// Asynchronous filesystem runtime for the swift target, over NIOFileSystem -- swift-nio's asynchronous filesystem
// API, which is the ecosystem's answer and not a thread pool of our own.
//
// WHY NOT FOUNDATION. FileManager and FileHandle are synchronous to the bone. Wrapping them in `Task.detached`
// gives an `async` signature over a blocked thread, which reads as asynchronous and is not: a thousand concurrent
// reads become a thousand stalled threads. NIOFileSystem runs the syscalls on a bounded pool with a real async
// interface, the same shape `tokio::fs` has on the rust target, so the two backends behave alike under load.
//
// TOTAL, LIKE THE REST OF THE NATIVE SURFACE. Every call here `throws` upstream and the public file API has no
// error channel, so a failure reads as the empty / false / zero answer. A handle open is the exception: a missing
// file there cannot be papered over.
//
// Reached only through the public file API. See note/term/stdlib/native-async-file-and-server.md.
import Foundation
import NIOCore
import _NIOFileSystem

enum aio {
  // An open file. NIOFileSystem addresses reads and writes by absolute offset and keeps no cursor, so the cursor
  // `seek` moves lives here. A class, not a struct, because the emitted `file` record holds it and every emitted
  // record is a value: two copies of the record must be two views of ONE open file, not two cursors.
  final class Handle: @unchecked Sendable {
    let file: ReadWriteFileHandle
    var at: Int64
    init(file: ReadWriteFileHandle, at: Int64) {
      self.file = file
      self.at = at
    }
  }

  // A read stream: the open file, where it is, and how much of the window is left (nil for "to the end").
  final class Reader: @unchecked Sendable {
    let file: ReadFileHandle
    var at: Int64
    var left: Int64?
    init(file: ReadFileHandle, at: Int64, left: Int64?) {
      self.file = file
      self.at = at
      self.left = left
    }
  }

  final class Writer: @unchecked Sendable {
    let file: WriteFileHandle
    var at: Int64
    init(file: WriteFileHandle, at: Int64) {
      self.file = file
      self.at = at
    }
  }

  private static var shared: FileSystem { FileSystem.shared }

  // ---- whole file ----

  static func fileRead(_ path: String) async -> String {
    guard let bytes = await readBuffer(path) else { return "" }
    return String(buffer: bytes)
  }

  static func fileReadBytes(_ path: String) async -> Data {
    guard let bytes = await readBuffer(path) else { return Data() }
    return Data(bytes.readableBytesView)
  }

  private static func readBuffer(_ path: String) async -> ByteBuffer? {
    do {
      return try await shared.withFileHandle(forReadingAt: FilePath(path)) { file in
        try await file.readToEnd(maximumSizeAllowed: .gibibytes(1))
      }
    } catch {
      return nil
    }
  }

  static func fileWrite(_ path: String, _ data: String) async {
    await writeBytes(path, Array(data.utf8), append: false)
  }

  static func fileWriteBytes(_ path: String, _ data: Data) async {
    await writeBytes(path, Array(data), append: false)
  }

  static func fileAppend(_ path: String, _ data: String) async {
    await writeBytes(path, Array(data.utf8), append: true)
  }

  private static func writeBytes(
    _ path: String,
    _ bytes: [UInt8],
    append: Bool
  ) async {
    do {
      let at = FilePath(path)
      let start: Int64 =
        append ? Int64((try? await shared.info(forFileAt: at)?.size) ?? 0) : 0
      let options: OpenOptions.Write =
        append
        ? .modifyFile(createIfNecessary: true)
        : .newFile(replaceExisting: true)

      try await shared.withFileHandle(forWritingAt: at, options: options) { file in
        _ = try await file.write(
          contentsOf: bytes,
          toAbsoluteOffset: start
        )
      }
    } catch {
      return
    }
  }

  static func fileCopy(_ from: String, _ to: String, _ deep: Bool) async {
    // NIOFileSystem's copyItem is already recursive for a directory, so `deep` only decides whether a directory
    // is allowed through at all: without it this is the single-file copy node's copyFile means.
    do {
      if !deep {
        let info = try await shared.info(forFileAt: FilePath(from))

        if info?.type == .directory {
          return
        }
      }

      try await shared.copyItem(at: FilePath(from), to: FilePath(to))
    } catch {
      return
    }
  }

  static func fileMove(_ from: String, _ to: String) async {
    try? await shared.moveItem(at: FilePath(from), to: FilePath(to))
  }

  static func fileRemove(_ path: String, _ deep: Bool) async {
    _ = try? await shared.removeItem(at: FilePath(path), recursively: deep)
  }

  // an empty `kind` asks only whether the path exists; "file", "directory" and "link" ask what it is
  static func fileTest(_ path: String, _ kind: String) async -> Bool {
    let at = FilePath(path)

    do {
      if kind == "link" {
        let info = try await shared.info(forFileAt: at, infoAboutSymbolicLink: true)
        return info?.type == .symlink
      }

      guard let info = try await shared.info(forFileAt: at) else { return false }

      switch kind {
      case "": return true
      case "file": return info.type == .regular
      case "directory": return info.type == .directory
      default: return true
      }
    } catch {
      return false
    }
  }

  // ---- link ----

  static func linkMake(_ from: String, _ to: String, _ hard: Bool) async {
    // NIOFileSystem has no hard link, and a hard link is one syscall: this is the same `link(2)` any crate calls.
    if hard {
      _ = from.withCString { source in
        to.withCString { target in link(source, target) }
      }

      return
    }

    try? await shared.createSymbolicLink(
      at: FilePath(to),
      withDestination: FilePath(from)
    )
  }

  static func linkRead(_ path: String) async -> String {
    guard
      let target = try? await shared.destinationOfSymbolicLink(at: FilePath(path))
    else {
      return ""
    }

    return target.string
  }

  // ---- permission and owner ----

  static func permissionRead(_ path: String) async -> Int {
    guard let info = try? await shared.info(forFileAt: FilePath(path)) else {
      return 0
    }

    return Int(info.permissions.rawValue)
  }

  static func permissionWrite(_ path: String, _ mode: Int) async {
    _ = path.withCString { chmod($0, mode_t(mode)) }
  }

  static func ownerUser(_ path: String) async -> Int {
    guard let info = try? await shared.info(forFileAt: FilePath(path)) else {
      return 0
    }

    return Int(info.userID.rawValue)
  }

  static func ownerGroup(_ path: String) async -> Int {
    guard let info = try? await shared.info(forFileAt: FilePath(path)) else {
      return 0
    }

    return Int(info.groupID.rawValue)
  }

  static func ownerWrite(_ path: String, _ user: Int, _ group: Int) async {
    _ = path.withCString { chown($0, uid_t(user), gid_t(group)) }
  }

  // ---- temporary ----

  // A unique name under the system temporary directory. The name is a uuid, so there is no retry loop and no
  // mkdtemp template: a collision cannot happen.
  static func temporaryMake(
    _ kind: String,
    _ prefix: String,
    _ suffix: String
  ) async -> String {
    let root =
      (try? await shared.temporaryDirectory)
      ?? FilePath(NSTemporaryDirectory())
    let name = "\(prefix)\(UUID().uuidString.lowercased())\(suffix)"
    let at = root.appending(name)

    if kind == "directory" {
      try? await shared.createDirectory(at: at, withIntermediateDirectories: true)
    } else {
      await writeBytes(at.string, [], append: false)
    }

    return at.string
  }

  // ---- handle ----

  static func handleOpen(
    _ path: String,
    _ read: Bool,
    _ write: Bool,
    _ create: Bool,
    _ append: Bool,
    _ clear: Bool
  ) async -> Handle {
    let at = FilePath(path)
    let options: OpenOptions.Write =
      clear && !append
      ? .newFile(replaceExisting: true)
      : .modifyFile(createIfNecessary: create)

    guard
      let file = try? await shared.openFile(
        forReadingAndWritingAt: at,
        options: options
      )
    else {
      fatalError("file handle open: \(path)")
    }

    // appending starts at the end, everything else at the start, which is what the open flags mean elsewhere
    let start: Int64 =
      append ? Int64((try? await shared.info(forFileAt: at)?.size) ?? 0) : 0

    return Handle(file: file, at: start)
  }

  static func handleClose(_ file: Handle) async {
    try? await file.file.close()
  }

  static func handleRead(_ file: Handle, _ size: Int) async -> String {
    guard size > 0 else { return "" }

    guard
      let chunk = try? await file.file.readChunk(
        fromAbsoluteOffset: file.at,
        length: .bytes(Int64(size))
      )
    else {
      return ""
    }

    file.at += Int64(chunk.readableBytes)

    return String(buffer: chunk)
  }

  static func handleWrite(_ file: Handle, _ data: String) async -> Int {
    let bytes = Array(data.utf8)

    guard
      (try? await file.file.write(contentsOf: bytes, toAbsoluteOffset: file.at))
        != nil
    else {
      return 0
    }

    file.at += Int64(bytes.count)

    return bytes.count
  }

  // `frame` is "start" (absolute), "relative" (from the cursor) or "end" (back from the end)
  static func handleSeek(_ file: Handle, _ offset: Int, _ frame: String) async {
    switch frame {
    case "relative":
      file.at += Int64(offset)
    case "end":
      let size = Int64((try? await file.file.info().size) ?? 0)
      file.at = size - Int64(offset)
    default:
      file.at = Int64(max(0, offset))
    }
  }

  static func handleFlush(_ file: Handle) async {
    // NIOFileSystem has no fsync of its own; the descriptor is the one the syscall wants
    try? await file.file.withUnsafeDescriptor { descriptor in
      _ = fsync(descriptor.rawValue)
    }
  }

  static func handleClear(_ file: Handle, _ size: Int) async {
    try? await file.file.resize(to: .bytes(Int64(max(0, size))))
    file.at = min(file.at, Int64(max(0, size)))
  }

  // ---- streams ----

  static func readerOpen(_ path: String, _ start: Int, _ size: Int) async -> Reader {
    guard let file = try? await shared.openFile(forReadingAt: FilePath(path))
    else {
      fatalError("file reader open: \(path)")
    }

    return Reader(
      file: file,
      at: Int64(max(0, start)),
      left: size > 0 ? Int64(size) : nil
    )
  }

  // the next chunk, or the empty text at the end of the stream (or of the window)
  static func readerNext(_ stream: Reader) async -> String {
    let want: Int64
    if let left = stream.left {
      if left <= 0 { return "" }
      want = min(left, 65536)
    } else {
      want = 65536
    }

    guard
      let chunk = try? await stream.file.readChunk(
        fromAbsoluteOffset: stream.at,
        length: .bytes(want)
      )
    else {
      return ""
    }

    stream.at += Int64(chunk.readableBytes)

    if let left = stream.left {
      stream.left = left - Int64(chunk.readableBytes)
    }

    return String(buffer: chunk)
  }

  static func readerClose(_ stream: Reader) async {
    try? await stream.file.close()
  }

  static func writerOpen(_ path: String, _ append: Bool) async -> Writer {
    let at = FilePath(path)
    let options: OpenOptions.Write =
      append ? .modifyFile(createIfNecessary: true) : .newFile(replaceExisting: true)

    guard let file = try? await shared.openFile(forWritingAt: at, options: options)
    else {
      fatalError("file writer open: \(path)")
    }

    let start: Int64 =
      append ? Int64((try? await shared.info(forFileAt: at)?.size) ?? 0) : 0

    return Writer(file: file, at: start)
  }

  static func writerPush(_ stream: Writer, _ data: String) async {
    let bytes = Array(data.utf8)

    guard
      (try? await stream.file.write(contentsOf: bytes, toAbsoluteOffset: stream.at))
        != nil
    else {
      return
    }

    stream.at += Int64(bytes.count)
  }

  static func writerClose(_ stream: Writer) async {
    try? await stream.file.close()
  }
}
