// The whole-folder remove of @term/base/file/remove for the swift target, over the C library, never awaiting. It
// answers a list of text, the refusal (refusal.swift: the code name of its errno, empty when carried out, the step and
// the host text) and the path the step named, which the public module raises as `failure` worded in Term
// (term/compiler decision 021 points 2, 4 and 1b).
//
// The walk is node's own (fs.rm with recursive and force: its option check's lstat, then rimraf), step for step, so a
// refusal names the step and the path node names: an lstat refused, an unlink, an rmdir, a scandir. ENOENT anywhere is
// no refusal, since nothing is there. An rmdir refused for any reason but ENOTEMPTY, EEXIST or EPERM raises at once,
// so a folder under a read-only parent keeps its entries, as node's does.
//
// The C calls are spelled through `Darwin` / `Glibc`: the emitted program may hold a task of the same name, which
// would shadow the C function in this file. errno is read before any other call.
//
// Reached only through the public file/remove API.
import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

enum fileRemove {
  // runtime-include: refusal.swift

  private static func refusedAt(_ number: Int32, _ step: String, _ path: String) -> [String] {
    refused(number, step) + [path]
  }

  private static func gone() -> [String] {
    carried() + [""]
  }

  // lstat(2): 0 and whether it is a folder, or the errno it refused with
  private static func kind(_ path: String) -> (Int32, Bool) {
    var found = stat()
    #if canImport(Darwin)
    let said = Darwin.lstat(path, &found)
    #else
    let said = Glibc.lstat(path, &found)
    #endif
    if said != 0 { return (errno, false) }
    return (0, (Int(found.st_mode) & Int(S_IFMT)) == Int(S_IFDIR))
  }

  private static func unlinkOne(_ path: String) -> Int32 {
    #if canImport(Darwin)
    return Darwin.unlink(path) == 0 ? 0 : errno
    #else
    return Glibc.unlink(path) == 0 ? 0 : errno
    #endif
  }

  private static func rmdirOne(_ path: String) -> Int32 {
    #if canImport(Darwin)
    return Darwin.rmdir(path) == 0 ? 0 : errno
    #else
    return Glibc.rmdir(path) == 0 ? 0 : errno
    #endif
  }

  // the names in a folder, but `.` and `..`, or the errno opendir(3) refused with
  private static func names(_ path: String) -> (Int32, [String]) {
    #if canImport(Darwin)
    guard let folder = Darwin.opendir(path) else { return (errno, []) }
    #else
    guard let folder = Glibc.opendir(path) else { return (errno, []) }
    #endif
    var out: [String] = []
    while true {
      #if canImport(Darwin)
      guard let entry = Darwin.readdir(folder) else { break }
      #else
      guard let entry = Glibc.readdir(folder) else { break }
      #endif
      // the name field copied out first, then read as the C text it holds (a read through the record's own field is an
      // overlapping access Swift refuses)
      let field = entry.pointee.d_name
      let name = withUnsafeBytes(of: field) { raw in String(cString: raw.bindMemory(to: CChar.self).baseAddress!) }
      if name != "." && name != ".." { out.append(name) }
    }
    #if canImport(Darwin)
    _ = Darwin.closedir(folder)
    #else
    _ = Glibc.closedir(folder)
    #endif
    return (0, out)
  }

  // fs.rm: the path's lstat first (a refusal but ENOENT raised), then the walk with the kind it read
  static func removePath(_ path: String) -> [String] {
    let (number, folder) = kind(path)
    if number == ENOENT { return gone() }
    if number != 0 { return refusedAt(number, "lstat", path) }
    return removeKnown(path, folder)
  }

  // rimraf on one entry under the folder: its lstat refused but for ENOENT, it is unlinked as node unlinks it
  private static func removeEntry(_ path: String) -> [String] {
    let (number, folder) = kind(path)
    if number == ENOENT { return gone() }
    return removeKnown(path, number == 0 && folder)
  }

  // a folder by rmdir, anything else by unlink, and an unlink refused with EISDIR or EPERM tried as a folder, its
  // refusal kept to answer when the rmdir says ENOTDIR
  private static func removeKnown(_ path: String, _ folder: Bool) -> [String] {
    if folder { return removeFolder(path, nil) }
    let number = unlinkOne(path)
    if number == 0 || number == ENOENT { return gone() }
    if number == EISDIR || number == EPERM { return removeFolder(path, refusedAt(number, "unlink", path)) }
    return refusedAt(number, "unlink", path)
  }

  private static func removeFolder(_ path: String, _ original: [String]?) -> [String] {
    let number = rmdirOne(path)
    if number == 0 || number == ENOENT { return gone() }
    if number == ENOTEMPTY || number == EEXIST || number == EPERM { return removeEntries(path) }
    if number == ENOTDIR { return original ?? refusedAt(number, "rmdir", path) }
    return refusedAt(number, "rmdir", path)
  }

  // the folder's entries, each removed in turn (the first refusal answered), then the folder's rmdir again
  private static func removeEntries(_ path: String) -> [String] {
    let (number, entries) = names(path)
    if number == ENOENT { return gone() }
    if number != 0 { return refusedAt(number, "scandir", path) }
    for name in entries {
      let done = removeEntry(path + "/" + name)
      if !done[0].isEmpty { return done }
    }
    let again = rmdirOne(path)
    if again == 0 || again == ENOENT { return gone() }
    return refusedAt(again, "rmdir", path)
  }
}
