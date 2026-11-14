// Whole-path file calls for the swift target that never await, over Foundation and the C library (NIOFileSystem,
// which the asynchronous side uses, is async only). `statPath` and `listPath` build the emitted `StatRaw` and
// `EntryRaw` records directly (the shim is prepended to the module that declares them, so the types are in scope),
// one call each. `changed` is seconds times 1000 plus nanoseconds over 1e6 in a Double, the arithmetic node's
// `mtimeMs` is.
//
// The C calls are spelled through `Darwin` / `Glibc` and named `lstat` and `realpath`, never `stat`: the emitted
// public module has a task called `stat`, which would shadow the C function of that name in this file.
//
// Reached only through the public file/blocking API, which has already ruled out a missing path.
import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

enum blocking {
  static func readPath(_ path: String) -> String {
    guard let data = FileManager.default.contents(atPath: path) else { return "" }

    return String(decoding: data, as: UTF8.self)
  }

  // a symbolic link is followed, so a link to nothing is not there
  static func existsPath(_ path: String) -> Bool {
    FileManager.default.fileExists(atPath: path)
  }

  // with every link followed, which is what `stat` describes: the link-free path, then `lstat` of that
  static func realPath(_ path: String) -> String {
    guard let resolved = realpath(path, nil) else { return path }
    defer { free(resolved) }

    return String(cString: resolved)
  }

  private static func entryKind(_ mode: mode_t) -> String {
    let type = mode & mode_t(S_IFMT)

    if type == mode_t(S_IFDIR) { return "directory" }
    if type == mode_t(S_IFLNK) { return "link" }
    if type == mode_t(S_IFREG) { return "file" }

    return "other"
  }

  static func statPath(_ path: String) -> StatRaw {
    #if canImport(Darwin)
    var info = Darwin.stat()
    #else
    var info = Glibc.stat()
    #endif

    guard lstat(realPath(path), &info) == 0 else {
      return StatRaw(kind: "other", size: 0, changed: 0.0)
    }

    #if canImport(Darwin)
    let seconds = info.st_mtimespec.tv_sec
    let nanoseconds = info.st_mtimespec.tv_nsec
    #else
    let seconds = info.st_mtim.tv_sec
    let nanoseconds = info.st_mtim.tv_nsec
    #endif

    return StatRaw(
      kind: entryKind(info.st_mode),
      size: Int(info.st_size),
      changed: Double(seconds) * 1000.0 + Double(nanoseconds) / 1e6
    )
  }

  // the platform's own order, no `.` or `..`, each kind the entry's own with links not followed
  static func listPath(_ path: String) -> [EntryRaw] {
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: path) else {
      return []
    }

    let base = path.hasSuffix("/") ? path : path + "/"
    var out: [EntryRaw] = []

    for name in names {
      #if canImport(Darwin)
      var info = Darwin.stat()
      #else
      var info = Glibc.stat()
      #endif

      let kind = lstat(base + name, &info) == 0 ? entryKind(info.st_mode) : "other"
      out.append(EntryRaw(name: name, kind: kind))
    }

    return out
  }

  // the path's own kind, links not followed (lstat), or "" when not even a link is there
  static func kindPath(_ path: String) -> String {
    #if canImport(Darwin)
    var info = Darwin.stat()
    #else
    var info = Glibc.stat()
    #endif

    guard lstat(path, &info) == 0 else { return "" }

    return entryKind(info.st_mode)
  }

  // the C calls, spelled through their module so no task of the emitted program can shadow them: rename(2) replaces
  // a file or an empty folder at `to` as node's renameSync, rmdir(2) is never recursive, symlink(2) writes the target
  // as given
  static func renamePath(_ from: String, _ to: String) -> Bool {
    #if canImport(Darwin)
    return Darwin.rename(from, to) == 0
    #else
    return Glibc.rename(from, to) == 0
    #endif
  }

  static func removeFolderPath(_ path: String) -> Bool {
    #if canImport(Darwin)
    return Darwin.rmdir(path) == 0
    #else
    return Glibc.rmdir(path) == 0
    #endif
  }

  static func linkPath(_ target: String, _ at: String) -> Bool {
    #if canImport(Darwin)
    return Darwin.symlink(target, at) == 0
    #else
    return Glibc.symlink(target, at) == 0
    #endif
  }

  // the whole text as UTF-8, the file made or cut, as node's writeFileSync (not atomic: no temporary file beside it)
  static func writePath(_ path: String, _ body: String) -> Bool {
    do {
      try body.write(toFile: path, atomically: false, encoding: .utf8)
      return true
    } catch {
      return false
    }
  }
}
