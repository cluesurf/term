// File metadata for the swift target, over POSIX `stat` / `lstat` handed back to the waiting task (`aio.handBack`,
// decision 001; the module that docks this docks `aio` too). It builds the emitted `FileMetadata` record directly
// (the shim is prepended to the module that declares it, so the type is in scope), which is what keeps one stat from
// becoming seven. Reached only through the public file/metadata API.
import Foundation

enum stat {
  // milliseconds since the epoch, the unit every backend's metadata reports
  private static func moment(_ time: timespec) -> Int {
    time.tv_sec * 1000 + time.tv_nsec / 1_000_000
  }

  static func metaRead(_ path: String, _ follow: Bool) async -> FileMetadata {
    await aio.handBack { metaOf(path, follow) }
  }

  private static func metaOf(_ path: String, _ follow: Bool) -> FileMetadata {
    var info = Foundation.stat()
    let found = follow ? Foundation.fstatat(AT_FDCWD, path, &info, 0) : Foundation.fstatat(AT_FDCWD, path, &info, AT_SYMLINK_NOFOLLOW)

    // a missing path reads as the zero record rather than throwing: the public API is total
    guard found == 0 else {
      return FileMetadata(
        size: 0,
        kind: "other",
        made: 0,
        changed: 0,
        opened: 0,
        mode: 0,
        link: false
      )
    }

    let type = info.st_mode & S_IFMT
    let kind: String
    switch type {
    case S_IFDIR: kind = "directory"
    case S_IFLNK: kind = "link"
    case S_IFREG: kind = "file"
    default: kind = "other"
    }

    // the last status change stands for `made`, as it did over NIOFileSystem, which surfaced no birth time: the
    // same answer on Linux, whose `stat` has none
    #if canImport(Darwin)
      let (made, changed, opened) = (info.st_ctimespec, info.st_mtimespec, info.st_atimespec)
    #else
      let (made, changed, opened) = (info.st_ctim, info.st_mtim, info.st_atim)
    #endif

    return FileMetadata(
      size: Int(info.st_size),
      kind: kind,
      made: moment(made),
      changed: moment(changed),
      opened: moment(opened),
      mode: Int(info.st_mode & 0o7777),
      link: type == S_IFLNK
    )
  }
}
