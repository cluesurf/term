// File metadata for the swift target, over NIOFileSystem's `info`. It builds the emitted `FileMetadata` record
// directly (the shim is prepended to the module that declares it, so the type is in scope), which is what keeps
// one stat from becoming seven. Reached only through the public file/metadata API.
import Foundation
import _NIOFileSystem

enum stat {
  // milliseconds since the epoch, the unit every backend's metadata reports
  private static func moment(_ time: FileInfo.Timespec) -> Int {
    time.seconds * 1000 + time.nanoseconds / 1_000_000
  }

  static func metaRead(_ path: String, _ follow: Bool) async -> FileMetadata {
    let info = try? await FileSystem.shared.info(
      forFileAt: FilePath(path),
      infoAboutSymbolicLink: !follow
    )

    // a missing path reads as the zero record rather than throwing: the public API is total
    guard let info else {
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

    let kind: String
    switch info.type {
    case .directory: kind = "directory"
    case .symlink: kind = "link"
    case .regular: kind = "file"
    default: kind = "other"
    }

    // POSIX has no birth time in `stat`, and NIOFileSystem does not surface the darwin one: the last status
    // change is the closest honest answer, and it is what `made` means on this backend.
    return FileMetadata(
      size: Int(info.size),
      kind: kind,
      made: moment(info.lastStatusChangeTime),
      changed: moment(info.lastDataModificationTime),
      opened: moment(info.lastAccessTime),
      mode: Int(info.permissions.rawValue),
      link: info.type == .symlink
    )
  }
}
