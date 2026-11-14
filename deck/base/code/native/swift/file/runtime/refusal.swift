  // ---- the refusal of a file call (term/compiler decision 021 points 4 and 4a) ----
  //
  // Included whole by aio.swift and blocking.swift (`// runtime-include: refusal.swift`), so each of the two enums
  // holds its own copy of this one source. A refused C call crosses as a list of text: the POSIX code name of its
  // errno, the step that failed as node's `syscall` names it, and the host's own text (strerror). A call carried out
  // answers the empty code name. Term words the note (@term/base/file/failure), never this file, and no record
  // crosses: about 25 modules dock aio.

  // the POSIX code name of an errno, read from the C library's own constants, so the numbers that differ between
  // Darwin and Linux need no table here. Any other number answers `?`, which no table row names, so the note is then
  // the host's own text
  static func codeName(_ number: Int32) -> String {
    switch number {
    case EPERM: return "EPERM"
    case ENOENT: return "ENOENT"
    case EIO: return "EIO"
    case EACCES: return "EACCES"
    case EEXIST: return "EEXIST"
    case ENOTDIR: return "ENOTDIR"
    case EISDIR: return "EISDIR"
    case ENOSPC: return "ENOSPC"
    case EROFS: return "EROFS"
    case EMLINK: return "EMLINK"
    case ENAMETOOLONG: return "ENAMETOOLONG"
    case ELOOP: return "ELOOP"
    case ENOTEMPTY: return "ENOTEMPTY"
    default: return "?"
    }
  }

  static func refused(_ number: Int32, _ step: String) -> [String] {
    [codeName(number), step, String(cString: strerror(number))]
  }

  static func carried() -> [String] {
    ["", "", ""]
  }
