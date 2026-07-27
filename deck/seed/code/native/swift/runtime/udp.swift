// UDP runtime over POSIX datagram sockets (Darwin / Glibc). The opaque handle a seed socket holds is the socket file
// descriptor (Int32). Each call is async to match the public UDP API; the syscalls are blocking. `receive` returns the
// seed `datagram` form with the payload and sender address. Reached only through the public UDP API.
import Foundation
#if canImport(Glibc)
import Glibc
#else
import Darwin
#endif

enum udp {
    private static func address(_ host: String, _ port: Int) -> sockaddr_in {
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(port)).bigEndian
        inet_pton(AF_INET, host, &addr.sin_addr)
        return addr
    }

    static func open(_ port: Int, _ host: String) async -> Int32 {
        let descriptor = socket(AF_INET, SOCK_DGRAM, 0)
        var yes: Int32 = 1
        setsockopt(descriptor, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = address(host, port)
        _ = withUnsafePointer(to: &addr) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.bind(descriptor, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return descriptor
    }

    static func send(_ descriptor: Int32, _ data: String, _ host: String, _ port: Int) async -> Int {
        var addr = address(host, port)
        let bytes = Array(data.utf8)
        let count = withUnsafePointer(to: &addr) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                bytes.withUnsafeBytes { raw in
                    Darwin.sendto(descriptor, raw.baseAddress, raw.count, 0, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
        }
        return count
    }

    static func receive(_ descriptor: Int32) async -> Datagram {
        var buffer = [UInt8](repeating: 0, count: 65536)
        var addr = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let count = withUnsafeMutablePointer(to: &addr) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.recvfrom(descriptor, &buffer, buffer.count, 0, sa, &length)
            }
        }
        if count <= 0 { return Datagram(data: "", host: "", port: 0) }
        let host = String(cString: inet_ntoa(addr.sin_addr))
        let port = Int(UInt16(bigEndian: addr.sin_port))
        return Datagram(
            data: String(decoding: buffer[0..<count], as: UTF8.self),
            host: host,
            port: port,
        )
    }

    static func close(_ descriptor: Int32) async { _ = Darwin.close(descriptor) }
}
