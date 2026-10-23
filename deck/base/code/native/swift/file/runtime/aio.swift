// Asynchronous filesystem runtime for the swift target: Foundation's FileManager and POSIX calls, each HANDED BACK
// (note/project/term/decision/001-native-work-hands-back-to-the-loop.md). `handBack` runs the blocking call on the
// runtime's pool of 4 worker threads and resumes the waiting task with its answer, so a read that blocks (a FIFO, a
// slow disk) stalls no other job. No swift-nio: a program that reads a file builds with plain `swiftc`, and
// NIOFileSystem was a blocking pool too (it runs its syscalls on NIOThreadPool).
//
// TOTAL, LIKE THE REST OF THE NATIVE SURFACE. The public file API has no error channel, so a failure reads as the
// empty / false / zero answer. A handle open is the exception: a missing file there cannot be papered over.
//
// `handBack` is the swift runtime's one hand-back: the stat and walk shims call it too, and their modules dock this
// one so it is in the program. Reached only through the public file API. See
// note/project/term/stdlib/native-async-file-and-server.md.
import Foundation

enum aio {
  // the runtime pool: 4 workers, libuv's default, so the pool is the same size on every backend. An
  // OperationQueue starts no thread until the first operation is added
  private static let pool: OperationQueue = {
    let queue = OperationQueue()
    queue.name = "term.hand-back"
    queue.maxConcurrentOperationCount = 4
    return queue
  }()

  // a blocking call run on the pool, its answer handed back to the task waiting on it
  static func handBack<T>(_ work: @escaping () -> T) async -> T {
    await withCheckedContinuation { (waiting: CheckedContinuation<T, Never>) in
      pool.addOperation { waiting.resume(returning: work()) }
    }
  }

  // An open file: its descriptor and the cursor `seek` moves. Reads and writes are positional (pread / pwrite) at
  // the cursor. A class, not a struct, because the emitted `file` record holds it and every emitted record is a
  // value: two copies of the record must be two views of ONE open file, not two cursors.
  final class Handle: @unchecked Sendable {
    let descriptor: Int32
    var at: Int64
    init(descriptor: Int32, at: Int64) {
      self.descriptor = descriptor
      self.at = at
    }
  }

  // A read stream: the open file, where it is, and how much of the window is left (nil for "to the end").
  final class Reader: @unchecked Sendable {
    let descriptor: Int32
    var at: Int64
    var left: Int64?
    init(descriptor: Int32, at: Int64, left: Int64?) {
      self.descriptor = descriptor
      self.at = at
      self.left = left
    }
  }

  final class Writer: @unchecked Sendable {
    let descriptor: Int32
    var at: Int64
    init(descriptor: Int32, at: Int64) {
      self.descriptor = descriptor
      self.at = at
    }
  }

  // ---- whole file ----

  static func fileRead(_ path: String) async -> String {
    await handBack { String(decoding: readWhole(path), as: UTF8.self) }
  }

  static func fileReadBytes(_ path: String) async -> Data {
    await handBack { Data(readWhole(path)) }
  }

  // every byte up to the end, read until `read` answers 0, so a pipe or a FIFO is read to its writer's close rather
  // than to the size `stat` gave when it was opened
  private static func readWhole(_ path: String) -> [UInt8] {
    let descriptor = Foundation.open(path, O_RDONLY)
    guard descriptor >= 0 else { return [] }
    defer { Foundation.close(descriptor) }

    var out: [UInt8] = []
    var chunk = [UInt8](repeating: 0, count: 65536)

    while true {
      let count = chunk.withUnsafeMutableBytes { Foundation.read(descriptor, $0.baseAddress, 65536) }
      if count <= 0 { break }
      out.append(contentsOf: chunk[0..<count])
    }

    return out
  }

  static func fileWrite(_ path: String, _ data: String) async {
    await handBack { writeBytes(path, Array(data.utf8), append: false) }
  }

  static func fileWriteBytes(_ path: String, _ data: Data) async {
    await handBack { writeBytes(path, Array(data), append: false) }
  }

  static func fileAppend(_ path: String, _ data: String) async {
    await handBack { writeBytes(path, Array(data.utf8), append: true) }
  }

  // the whole of `bytes` written through one descriptor, replacing the file or added at its end
  private static func writeBytes(_ path: String, _ bytes: [UInt8], append: Bool) {
    let flags = O_WRONLY | O_CREAT | (append ? O_APPEND : O_TRUNC)
    let descriptor = Foundation.open(path, flags, 0o644)
    guard descriptor >= 0 else { return }
    defer { Foundation.close(descriptor) }
    _ = writeAll(descriptor, bytes, at: nil)
  }

  // every byte written, at `at` (pwrite) or at the descriptor's own offset; the count written
  private static func writeAll(_ descriptor: Int32, _ bytes: [UInt8], at: Int64?) -> Int {
    var done = 0
    while done < bytes.count {
      let count = bytes[done...].withUnsafeBytes { chunk -> Int in
        if let at {
          return Foundation.pwrite(descriptor, chunk.baseAddress, chunk.count, off_t(at + Int64(done)))
        }
        return Foundation.write(descriptor, chunk.baseAddress, chunk.count)
      }
      if count <= 0 { break }
      done += count
    }
    return done
  }

  // up to `size` bytes at `at`; the bytes read, fewer at the end of the file
  private static func readAt(_ descriptor: Int32, _ size: Int, at: Int64) -> [UInt8] {
    guard size > 0 else { return [] }
    var buffer = [UInt8](repeating: 0, count: size)
    let count = buffer.withUnsafeMutableBytes { chunk in
      Foundation.pread(descriptor, chunk.baseAddress, size, off_t(at))
    }
    return count > 0 ? Array(buffer[0..<count]) : []
  }

  static func fileCopy(_ from: String, _ to: String, _ deep: Bool) async {
    // FileManager's copyItem is already recursive for a directory, so `deep` only decides whether a directory is
    // allowed through at all: without it this is the single-file copy node's copyFile means.
    await handBack {
      var directory: ObjCBool = false
      guard FileManager.default.fileExists(atPath: from, isDirectory: &directory) else { return }
      if directory.boolValue && !deep { return }
      try? FileManager.default.copyItem(atPath: from, toPath: to)
    }
  }

  static func fileMove(_ from: String, _ to: String) async {
    await handBack { try? FileManager.default.moveItem(atPath: from, toPath: to) }
  }

  // `deep` removes a directory tree. Without it a directory is still removed when empty, so `remove` means the
  // same thing on a file and on a directory, the way node's `rm` does.
  static func fileRemove(_ path: String, _ deep: Bool) async {
    await handBack {
      if deep {
        try? FileManager.default.removeItem(atPath: path)
      } else {
        _ = Foundation.remove(path)
      }
    }
  }

  // an empty `kind` asks only whether the path exists; "file", "directory" and "link" ask what it is
  static func fileTest(_ path: String, _ kind: String) async -> Bool {
    await handBack {
      var info = Foundation.stat()

      if kind == "link" {
        guard Foundation.fstatat(AT_FDCWD, path, &info, AT_SYMLINK_NOFOLLOW) == 0 else { return false }
        return (info.st_mode & S_IFMT) == S_IFLNK
      }

      guard Foundation.fstatat(AT_FDCWD, path, &info, 0) == 0 else { return false }

      switch kind {
      case "": return true
      case "file": return (info.st_mode & S_IFMT) == S_IFREG
      case "directory": return (info.st_mode & S_IFMT) == S_IFDIR
      default: return true
      }
    }
  }

  // ---- link ----

  static func linkMake(_ from: String, _ to: String, _ hard: Bool) async {
    await handBack {
      if hard {
        _ = Foundation.link(from, to)
      } else {
        _ = Foundation.symlink(from, to)
      }
    }
  }

  static func linkRead(_ path: String) async -> String {
    await handBack { (try? FileManager.default.destinationOfSymbolicLink(atPath: path)) ?? "" }
  }

  // ---- permission and owner ----

  static func permissionRead(_ path: String) async -> Int {
    await handBack {
      var info = Foundation.stat()
      guard Foundation.fstatat(AT_FDCWD, path, &info, 0) == 0 else { return 0 }
      return Int(info.st_mode & 0o7777)
    }
  }

  static func permissionWrite(_ path: String, _ mode: Int) async {
    await handBack { _ = Foundation.chmod(path, mode_t(mode)) }
  }

  static func ownerUser(_ path: String) async -> Int {
    await handBack {
      var info = Foundation.stat()
      guard Foundation.fstatat(AT_FDCWD, path, &info, 0) == 0 else { return 0 }
      return Int(info.st_uid)
    }
  }

  static func ownerGroup(_ path: String) async -> Int {
    await handBack {
      var info = Foundation.stat()
      guard Foundation.fstatat(AT_FDCWD, path, &info, 0) == 0 else { return 0 }
      return Int(info.st_gid)
    }
  }

  static func ownerWrite(_ path: String, _ user: Int, _ group: Int) async {
    await handBack { _ = Foundation.chown(path, uid_t(user), gid_t(group)) }
  }

  // ---- temporary ----

  // A unique name under the system temporary directory. The name is a uuid, so there is no retry loop and no
  // mkdtemp template: a collision cannot happen.
  static func temporaryMake(_ kind: String, _ prefix: String, _ suffix: String) async -> String {
    let name = "\(prefix)\(UUID().uuidString.lowercased())\(suffix)"
    let at = (NSTemporaryDirectory() as NSString).appendingPathComponent(name)

    return await handBack {
      if kind == "directory" {
        try? FileManager.default.createDirectory(atPath: at, withIntermediateDirectories: true)
      } else {
        writeBytes(at, [], append: false)
      }

      return at
    }
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
    await handBack {
      var flags = O_RDWR
      if create { flags |= O_CREAT }
      if clear && !append { flags |= O_TRUNC }

      let descriptor = Foundation.open(path, flags, 0o644)
      if descriptor < 0 {
        fatalError("file handle open: \(path)")
      }

      // appending starts at the end, everything else at the start, which is what the open flags mean elsewhere
      let start: Int64 = append ? Int64(Foundation.lseek(descriptor, 0, SEEK_END)) : 0

      return Handle(descriptor: descriptor, at: start)
    }
  }

  static func handleClose(_ file: Handle) async {
    await handBack { _ = Foundation.close(file.descriptor) }
  }

  static func handleRead(_ file: Handle, _ size: Int) async -> String {
    await handBack {
      let bytes = readAt(file.descriptor, size, at: file.at)
      file.at += Int64(bytes.count)
      return String(decoding: bytes, as: UTF8.self)
    }
  }

  static func handleWrite(_ file: Handle, _ data: String) async -> Int {
    await handBack {
      let bytes = Array(data.utf8)
      let count = writeAll(file.descriptor, bytes, at: file.at)
      guard count == bytes.count else { return 0 }
      file.at += Int64(count)
      return count
    }
  }

  // `frame` is "start" (absolute), "relative" (from the cursor) or "end" (back from the end)
  static func handleSeek(_ file: Handle, _ offset: Int, _ frame: String) async {
    await handBack {
      switch frame {
      case "relative":
        file.at += Int64(offset)
      case "end":
        var info = Foundation.stat()
        let size = Foundation.fstat(file.descriptor, &info) == 0 ? Int64(info.st_size) : 0
        file.at = size - Int64(offset)
      default:
        file.at = Int64(max(0, offset))
      }
    }
  }

  static func handleFlush(_ file: Handle) async {
    await handBack { _ = Foundation.fsync(file.descriptor) }
  }

  static func handleClear(_ file: Handle, _ size: Int) async {
    await handBack {
      _ = Foundation.ftruncate(file.descriptor, off_t(max(0, size)))
      file.at = min(file.at, Int64(max(0, size)))
    }
  }

  // ---- streams ----

  static func readerOpen(_ path: String, _ start: Int, _ size: Int) async -> Reader {
    await handBack {
      let descriptor = Foundation.open(path, O_RDONLY)
      if descriptor < 0 {
        fatalError("file reader open: \(path)")
      }

      return Reader(descriptor: descriptor, at: Int64(max(0, start)), left: size > 0 ? Int64(size) : nil)
    }
  }

  // the next chunk, or the empty text at the end of the stream (or of the window)
  static func readerNext(_ stream: Reader) async -> String {
    await handBack {
      let want: Int64
      if let left = stream.left {
        if left <= 0 { return "" }
        want = min(left, 65536)
      } else {
        want = 65536
      }

      let bytes = readAt(stream.descriptor, Int(want), at: stream.at)
      stream.at += Int64(bytes.count)

      if let left = stream.left {
        stream.left = left - Int64(bytes.count)
      }

      return String(decoding: bytes, as: UTF8.self)
    }
  }

  static func readerClose(_ stream: Reader) async {
    await handBack { _ = Foundation.close(stream.descriptor) }
  }

  static func writerOpen(_ path: String, _ append: Bool) async -> Writer {
    await handBack {
      let descriptor = Foundation.open(path, O_WRONLY | O_CREAT | (append ? 0 : O_TRUNC), 0o644)
      if descriptor < 0 {
        fatalError("file writer open: \(path)")
      }

      let start: Int64 = append ? Int64(Foundation.lseek(descriptor, 0, SEEK_END)) : 0

      return Writer(descriptor: descriptor, at: start)
    }
  }

  static func writerPush(_ stream: Writer, _ data: String) async {
    await handBack {
      let bytes = Array(data.utf8)
      let count = writeAll(stream.descriptor, bytes, at: stream.at)
      stream.at += Int64(count)
    }
  }

  static func writerClose(_ stream: Writer) async {
    await handBack { _ = Foundation.close(stream.descriptor) }
  }
}
