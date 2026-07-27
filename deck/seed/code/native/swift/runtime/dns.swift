import Foundation

// DNS over POSIX getaddrinfo, rendering each address as a numeric host string (getnameinfo with NI_NUMERICHOST). This
// is the same resolver path the other platforms use, so localhost and numeric IPs resolve without a network round trip.
enum dns {
    private static func lookup(_ hostname: String) -> [String] {
        var hints = addrinfo()
        hints.ai_family = AF_UNSPEC
        hints.ai_socktype = SOCK_STREAM
        var result: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(hostname, nil, &hints, &result) == 0 else { return [] }
        defer { freeaddrinfo(result) }
        var addresses: [String] = []
        var pointer = result
        while let current = pointer {
            var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let code = getnameinfo(
                current.pointee.ai_addr, current.pointee.ai_addrlen,
                &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST,
            )
            if code == 0 { addresses.append(String(cString: buffer)) }
            pointer = current.pointee.ai_next
        }
        return addresses
    }
    static func resolve(_ hostname: String) -> [String] { lookup(hostname) }
    static func resolveOne(_ hostname: String) -> String { lookup(hostname).first ?? "" }
}
