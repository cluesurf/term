// The two raising disk calls of @term/base/file/create for the swift target, over the C library, never awaiting. Each
// answers a list of text, the refusal (refusal.swift: the code name of its errno, empty when carried out, the step and
// the host text), which the public module raises as `failure` worded in Term (term/compiler decision 021 points 2, 4
// and 1b).
//
// The C calls are spelled through `Darwin` / `Glibc`: the emitted program may hold a task called `write`, `open` or
// `close`, which would shadow the C function of that name in this file. errno is read before any other call.
//
// Reached only through the public file/create API.
import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

enum fileCreate {
  // runtime-include: refusal.swift

  private static func isFolder(_ path: String) -> Bool {
    var folder: ObjCBool = false
    return FileManager.default.fileExists(atPath: path, isDirectory: &folder) && folder.boolValue
  }

  private static func makeOne(_ path: String) -> Int32 {
    #if canImport(Darwin)
    return Darwin.mkdir(path, 0o777) == 0 ? 0 : errno
    #else
    return Glibc.mkdir(path, 0o777) == 0 ? 0 : errno
    #endif
  }

  // mkdir(2) of the folder, and on ENOENT of every missing folder above it first, as node's recursive mkdirSync: a
  // folder already there is carried out (0), anything else answers the errno of the mkdir that refused
  private static func makeAll(_ path: String) -> Int32 {
    let first = makeOne(path)
    if first == 0 { return 0 }
    if first == EEXIST { return isFolder(path) ? 0 : first }
    guard first == ENOENT else { return first }

    let parent = (path as NSString).deletingLastPathComponent
    guard !parent.isEmpty, parent != path else { return first }

    let above = makeAll(parent)
    if above != 0 { return above }

    let again = makeOne(path)
    if again == 0 { return 0 }
    if again == EEXIST && isFolder(path) { return 0 }

    return again
  }

  // node names the path given whichever folder of the chain refused, so the step alone crosses
  static func makeFolderPath(_ path: String) -> [String] {
    let number = makeAll(path)

    return number == 0 ? carried() : refused(number, "mkdir")
  }

  // open(2) with O_CREAT and O_EXCL (node's `wx`) is the `open` step, mode 0666 before the umask as node's, and the
  // writes the `write` step
  static func writeNewPath(_ path: String, _ body: String) -> [String] {
    #if canImport(Darwin)
    let descriptor = Darwin.open(path, O_WRONLY | O_CREAT | O_EXCL, 0o666)
    #else
    let descriptor = Glibc.open(path, O_WRONLY | O_CREAT | O_EXCL, 0o666)
    #endif
    guard descriptor >= 0 else { return refused(errno, "open") }

    let bytes = Array(body.utf8)
    var at = 0
    var number: Int32 = 0

    while at < bytes.count {
      let count = bytes[at...].withUnsafeBufferPointer { chunk -> Int in
        #if canImport(Darwin)
        return Darwin.write(descriptor, chunk.baseAddress, chunk.count)
        #else
        return Glibc.write(descriptor, chunk.baseAddress, chunk.count)
        #endif
      }
      if count < 0 {
        number = errno
        break
      }
      at += count
    }

    #if canImport(Darwin)
    _ = Darwin.close(descriptor)
    #else
    _ = Glibc.close(descriptor)
    #endif

    return number == 0 ? carried() : refused(number, "write")
  }
}
