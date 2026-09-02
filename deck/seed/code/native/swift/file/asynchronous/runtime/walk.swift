// Directory reading for the swift target, over NIOFileSystem's DirectoryEntries async sequence. `dirList` is one
// level or every level as relative paths; `dirWalk` is every level as `WalkEntry` records (path, kind, depth),
// which is the form the module that docks this declares. Reached only through the public file/directory API.
import Foundation
import _NIOFileSystem

enum walk {
  private static var shared: FileSystem { FileSystem.shared }

  static func dirMake(_ path: String) async {
    try? await shared.createDirectory(
      at: FilePath(path),
      withIntermediateDirectories: true
    )
  }

  // one level, or every level below it as paths relative to `path`
  static func dirList(_ path: String, _ deep: Bool) async -> [String] {
    var out: [String] = []
    let root = FilePath(path)

    do {
      try await shared.withDirectoryHandle(atPath: root) { directory in
        for try await entry in directory.listContents(recursive: deep) {
          out.append(relative(entry.path, under: root))
        }
      }
    } catch {
      return out
    }

    return out
  }

  // every entry beneath `path`, with what it is and how far below the root it sits. `depth` 0 walks all the way
  // down, which is what node's own recursive readdir does.
  static func dirWalk(_ path: String, _ depth: Int) async -> [WalkEntry] {
    var out: [WalkEntry] = []
    let root = FilePath(path)

    do {
      try await shared.withDirectoryHandle(atPath: root) { directory in
        for try await entry in directory.listContents(recursive: true) {
          let level = depthOf(entry.path, under: root)

          // recursive listing has no depth bound of its own, so the bound is applied here
          if depth > 0 && level >= depth {
            continue
          }

          out.append(
            WalkEntry(
              path: entry.path.string,
              kind: name(entry.type),
              depth: level
            )
          )
        }
      }
    } catch {
      return out
    }

    return out
  }

  private static func name(_ type: FileType) -> String {
    switch type {
    case .directory: return "directory"
    case .symlink: return "link"
    case .regular: return "file"
    default: return "other"
    }
  }

  private static func relative(_ path: FilePath, under root: FilePath) -> String {
    let whole = path.string
    let base = root.string.hasSuffix("/") ? root.string : root.string + "/"

    return whole.hasPrefix(base) ? String(whole.dropFirst(base.count)) : whole
  }

  private static func depthOf(_ path: FilePath, under root: FilePath) -> Int {
    relative(path, under: root).split(separator: "/").count - 1
  }
}
