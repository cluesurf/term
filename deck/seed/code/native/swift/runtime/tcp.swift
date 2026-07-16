// TCP runtime over POSIX sockets (Darwin / Glibc). The opaque handle a seed connection / listener holds is the socket
// file descriptor (Int32). Each call is async to match the public TCP API; the underlying syscalls are blocking, which
// is enough for the sequential connect / accept flow (the kernel completes the handshake into the listen backlog).
// Reached only through the public TCP API.
import Foundation
#if canImport(Glibc)
import Glibc
#else
import Darwin
#endif

enum tcp {
    private static func address(_ host: String, _ port: Int) -> sockaddr_in {
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(port)).bigEndian
        inet_pton(AF_INET, host, &addr.sin_addr)
        return addr
    }

    static func connect(_ host: String, _ port: Int, _ secure: Bool) async -> Int32 {
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        var addr = address(host, port)
        _ = withUnsafePointer(to: &addr) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.connect(descriptor, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return descriptor
    }

    static func listen(
        _ port: Int,
        _ host: String,
        _ secure: Bool,
        _ certificate: String,
        _ key: String,
    ) async -> Int32 {
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        var yes: Int32 = 1
        setsockopt(descriptor, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = address(host, port)
        _ = withUnsafePointer(to: &addr) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.bind(descriptor, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        Darwin.listen(descriptor, 50)
        return descriptor
    }

    static func accept(_ server: Int32) async -> Int32 {
        return Darwin.accept(server, nil, nil)
    }

    static func read(_ descriptor: Int32) async -> String {
        var buffer = [UInt8](repeating: 0, count: 65536)
        let count = Darwin.read(descriptor, &buffer, buffer.count)
        if count <= 0 { return "" }
        return String(decoding: buffer[0..<count], as: UTF8.self)
    }

    static func write(_ descriptor: Int32, _ data: String) async -> Int {
        let bytes = Array(data.utf8)
        let count = bytes.withUnsafeBytes { raw in
            Darwin.write(descriptor, raw.baseAddress, raw.count)
        }
        return count
    }

    static func close(_ descriptor: Int32) async { _ = Darwin.close(descriptor) }

    static func closeServer(_ descriptor: Int32) async { _ = Darwin.close(descriptor) }
}
