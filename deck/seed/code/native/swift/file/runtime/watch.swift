// Filesystem watching for the swift target, over a DispatchSource file-system-object source: the kqueue the
// system already runs, not a polling loop and not a package.
//
// The API is PULL, not callback: `watchOpen` starts the watch, `watchNext` awaits the next change, `watchClose`
// stops it. That is the one shape all four backends can hold (node's fs.watch async iterator, notify's channel,
// this, the JVM's WatchService), so the Term API above it is the same everywhere.
//
// NAMED GAP: kqueue reports that a watched path changed, not what changed inside it, and it cannot watch a tree.
// So `deep` is accepted and does nothing here, and a change under a watched directory arrives as one "change" on
// the directory. FSEvents is the darwin API that does both and is not portable to swift on Linux; a watcher that
// covers `deep` properly is its own piece of work, recorded in note/term/stdlib/native-async-file-and-server.md.
//
// Reached only through the public file/watch API.
import Dispatch
import Foundation

enum watch {
  // the running watch: the descriptor and its dispatch source, plus a queue of changes the source has posted and
  // nobody has taken yet, and whoever is waiting for one
  final class Watcher: @unchecked Sendable {
    let lock = NSLock()
    var descriptor: Int32 = -1
    var source: DispatchSourceFileSystemObject?
    var ready: [WatchEvent] = []
    var waiting: CheckedContinuation<WatchEvent, Never>?
    var closed = false
    let path: String

    init(path: String) {
      self.path = path
    }

    // hand the change to whoever is waiting, or hold it until someone asks
    func post(_ event: WatchEvent) {
      lock.lock()
      let waiter = waiting
      waiting = nil

      if waiter == nil {
        ready.append(event)
      }

      lock.unlock()
      waiter?.resume(returning: event)
    }
  }

  static func watchOpen(_ path: String, _ deep: Bool) async -> Watcher {
    let watcher = Watcher(path: path)
    let descriptor = open(path, O_EVTONLY)

    guard descriptor >= 0 else {
      return watcher
    }

    let source = DispatchSource.makeFileSystemObjectSource(
      fileDescriptor: descriptor,
      eventMask: [.write, .delete, .rename, .extend, .attrib],
      queue: DispatchQueue.global()
    )

    source.setEventHandler {
      let mask = source.data
      let kind: String

      if mask.contains(.delete) {
        kind = "remove"
      } else if mask.contains(.rename) {
        kind = "create"
      } else if mask.contains(.write) || mask.contains(.extend)
        || mask.contains(.attrib)
      {
        kind = "change"
      } else {
        kind = "other"
      }

      watcher.post(WatchEvent(kind: kind, path: path))
    }

    source.setCancelHandler {
      close(descriptor)
    }

    watcher.descriptor = descriptor
    watcher.source = source
    source.resume()

    return watcher
  }

  // the next change. A closed watcher answers with the empty event rather than waiting forever, so a loop over
  // `watchNext` ends after `watchClose`.
  static func watchNext(_ watcher: Watcher) async -> WatchEvent {
    await withCheckedContinuation { (hold: CheckedContinuation<WatchEvent, Never>) in
      watcher.lock.lock()

      if !watcher.ready.isEmpty {
        let event = watcher.ready.removeFirst()
        watcher.lock.unlock()
        hold.resume(returning: event)

        return
      }

      if watcher.closed {
        watcher.lock.unlock()
        hold.resume(returning: WatchEvent(kind: "", path: ""))

        return
      }

      watcher.waiting = hold
      watcher.lock.unlock()
    }
  }

  static func watchClose(_ watcher: Watcher) async {
    watcher.lock.lock()
    watcher.closed = true
    let waiter = watcher.waiting
    watcher.waiting = nil
    let source = watcher.source
    watcher.source = nil
    watcher.lock.unlock()

    source?.cancel()
    waiter?.resume(returning: WatchEvent(kind: "", path: ""))
  }
}
