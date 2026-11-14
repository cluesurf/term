// Signals sent to another process: kill(2) of the C library, spelled through `Darwin` / `Glibc` so no name of the
// emitted program can stand in for it. Reached only through the public process/signal API, which hands only an id
// from 1 to the Int32 range and a signal's POSIX number.
import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

enum signalSender {
    // whether kill(2) took the signal: false when no process has the id (ESRCH) or this one may not signal it (EPERM)
    static func send(_ id: Int, _ number: Int) -> Bool {
        #if canImport(Darwin)
        return Darwin.kill(pid_t(id), Int32(number)) == 0
        #else
        return Glibc.kill(pid_t(id), Int32(number)) == 0
        #endif
    }
}
