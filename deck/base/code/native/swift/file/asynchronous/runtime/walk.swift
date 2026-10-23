// Directory reading for the swift target, over FileManager handed back to the waiting task (`aio.handBack`, decision
// 001; the module that docks this docks `aio` too). `dirList` is one level or every level as relative paths;
// `dirWalk` is every level as `WalkEntry` records (path, kind, depth), which is the form the module that docks this
// declares. Reached only through the public file/directory API.
import Foundation

enum walkFile {
  static func dirMake(_ path: String) async {
    await aio.handBack {
      try? FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    }
  }

  // one level, or every level below it as paths relative to `path`
  static func dirList(_ path: String, _ deep: Bool) async -> [String] {
    await aio.handBack {
      if !deep {
        return (try? FileManager.default.contentsOfDirectory(atPath: path)) ?? []
      }

      var out: [String] = []
      step(path, "", 0) { relative, _, _ in out.append(relative) }

      return out
    }
  }

  // every entry beneath `path`, with what it is and how far below the root it sits. `depth` 0 walks all the way
  // down, which is what node's own recursive readdir does.
  static func dirWalk(_ path: String, _ depth: Int) async -> [WalkEntry] {
    await aio.handBack {
      var out: [WalkEntry] = []
      let base = path.hasSuffix("/") ? path : path + "/"

      step(path, "", 0) { relative, kind, level in
        if depth == 0 || level < depth {
          out.append(WalkEntry(path: base + relative, kind: kind, depth: level))
        }
      }

      return out
    }
  }

  // what an entry is, asked of the entry itself and never of what a link points at
  private static func kindOf(_ path: String) -> String {
    var info = Foundation.stat()
    guard Foundation.fstatat(AT_FDCWD, path, &info, AT_SYMLINK_NOFOLLOW) == 0 else { return "other" }

    switch info.st_mode & S_IFMT {
    case S_IFDIR: return "directory"
    case S_IFLNK: return "link"
    case S_IFREG: return "file"
    default: return "other"
    }
  }

  // depth-first, handing each entry its path relative to the root, what it is and its level below the root
  private static func step(
    _ root: String,
    _ prefix: String,
    _ level: Int,
    _ take: (String, String, Int) -> Void
  ) {
    let at = prefix.isEmpty ? root : (root as NSString).appendingPathComponent(prefix)
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: at) else { return }

    for name in names {
      let relative = prefix.isEmpty ? name : prefix + "/" + name
      let kind = kindOf((root as NSString).appendingPathComponent(relative))

      take(relative, kind, level)

      if kind == "directory" {
        step(root, relative, level + 1, take)
      }
    }
  }
}
