// swift HTTP server runtime over POSIX sockets (Foundation / Darwin -- no SwiftNIO or external package). It binds a
// listening socket, accepts connections, parses each request line into a normalized Request, calls the seed handler, and
// writes the response. `serve` blocks for the life of the process -- the entry point of a server binary. Reached only
// through the public network/server API.
import Foundation

enum runtime {
  static func serve(_ port: Int, _ host: String, _ handler: (Request) -> Response) {
    let listenFd = socket(AF_INET, SOCK_STREAM, 0)
    var yes: Int32 = 1
    setsockopt(listenFd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))

    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = in_port_t(UInt16(port)).bigEndian
    addr.sin_addr.s_addr = inet_addr(host)

    _ = withUnsafePointer(to: &addr) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
        bind(listenFd, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    listen(listenFd, 16)

    while true {
      let client = accept(listenFd, nil, nil)
      if client < 0 { continue }

      var buffer = [UInt8](repeating: 0, count: 8192)
      let count = read(client, &buffer, 8192)
      let text = count > 0 ? String(decoding: buffer[0..<count], as: UTF8.self) : ""

      let firstLine = text.components(separatedBy: "\r\n").first ?? ""
      let parts = firstLine.split(separator: " ").map(String.init)
      let method = parts.count > 0 ? parts[0] : "GET"
      let target = parts.count > 1 ? parts[1] : "/"
      let pathQuery = target.split(separator: "?", maxSplits: 1).map(String.init)
      let path = pathQuery.count > 0 ? pathQuery[0] : "/"
      let query = pathQuery.count > 1 ? pathQuery[1] : ""
      var body = ""
      if let range = text.range(of: "\r\n\r\n") {
        body = String(text[range.upperBound...])
      }

      let request = Request(
        method: method,
        url: target,
        path: path,
        query: query,
        headers: SeedMap<Int, Int>([:]),
        body: body,
        dock: 0
      )
      let response = handler(request)
      let payload = "HTTP/1.1 \(response.status) OK\r\nContent-Length: \(response.body.utf8.count)\r\nConnection: close\r\n\r\n\(response.body)"
      let bytes = Array(payload.utf8)
      _ = bytes.withUnsafeBytes { raw in
        write(client, raw.baseAddress, bytes.count)
      }
      close(client)
    }
  }
}
