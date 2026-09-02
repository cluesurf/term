// Synchronous file handles for the swift target, over Foundation's FileHandle. The asynchronous side is
// NIOFileSystem; this is the same operations with nothing to await, for the places that cannot wait or should
// not.
//
// Reached only through the public file/synchronous API.
import Foundation

enum grip {
  // a class, not a struct, because the emitted record is a value and two copies of it must be two views of ONE
  // open file rather than two cursors
  final class Grip {
    let handle: FileHandle
    init(handle: FileHandle) { self.handle = handle }
  }

  static func gripOpen(
    _ path: String,
    _ read: Bool,
    _ write: Bool,
    _ create: Bool,
    _ append: Bool,
    _ clear: Bool
  ) -> Grip {
    let manager = FileManager.default

    if create && !manager.fileExists(atPath: path) {
      manager.createFile(atPath: path, contents: nil)
    }

    let handle: FileHandle?

    if write || append || clear {
      handle = read
        ? FileHandle(forUpdatingAtPath: path)
        : FileHandle(forWritingAtPath: path)
    } else {
      handle = FileHandle(forReadingAtPath: path)
    }

    guard let handle else {
      fatalError("synchronous file open: \(path)")
    }

    if clear && !append {
      try? handle.truncate(atOffset: 0)
    }

    if append {
      _ = try? handle.seekToEnd()
    }

    return Grip(handle: handle)
  }

  static func gripClose(_ file: Grip) {
    try? file.handle.close()
  }

  static func gripRead(_ file: Grip, _ size: Int) -> String {
    guard size > 0 else { return "" }
    guard let data = try? file.handle.read(upToCount: size) else { return "" }

    return String(decoding: data, as: UTF8.self)
  }

  static func gripWrite(_ file: Grip, _ data: String) -> Int {
    let bytes = Data(data.utf8)

    do {
      try file.handle.write(contentsOf: bytes)
    } catch {
      return 0
    }

    return bytes.count
  }

  static func gripSeek(_ file: Grip, _ offset: Int, _ frame: String) {
    switch frame {
    case "relative":
      let at = (try? file.handle.offset()) ?? 0
      try? file.handle.seek(toOffset: at + UInt64(max(0, offset)))
    case "end":
      let end = (try? file.handle.seekToEnd()) ?? 0
      try? file.handle.seek(toOffset: end - UInt64(max(0, offset)))
    default:
      try? file.handle.seek(toOffset: UInt64(max(0, offset)))
    }
  }

  static func gripFlush(_ file: Grip) {
    try? file.handle.synchronize()
  }

  static func gripClear(_ file: Grip, _ size: Int) {
    try? file.handle.truncate(atOffset: UInt64(max(0, size)))
  }
}
