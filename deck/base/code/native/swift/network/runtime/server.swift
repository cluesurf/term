// HTTP server runtime for the swift target, over Hummingbird on swift-nio -- the server-side swift ecosystem's
// stack, not an accept loop of our own.
//
// WHAT THE POSIX LOOP DID NOT DO. The previous shim did one `read` of 8192 bytes per connection, took whatever
// came as the whole request, never parsed a header into the request record at all (it passed an empty map), and
// closed after answering. So: no keep-alive, no header the handler could read, a body larger than one packet
// silently truncated, and no TLS. Hummingbird and NIO do all of it.
//
// Hummingbird rather than Vapor: Vapor is batteries-included and brings a router, an ORM boundary and a
// templating story the Term API already has its own answers for. Hummingbird is the thin one, which is the layer
// this belongs at.
//
// Reached only through the public network/server API. See note/term/stdlib/native-async-file-and-server.md.
import Foundation
import HTTPTypes
import Hummingbird
import HummingbirdCore
import HummingbirdHTTP2
import HummingbirdTLS
import NIOCore
import NIOPosix
import NIOSSL

enum runtime {
  // a running server: how to tell it to stop, and the port it bound
  final class Running: @unchecked Sendable {
    var stop: (() -> Void)?
    let port: Int
    init(stop: (() -> Void)?, port: Int) {
      self.stop = stop
      self.port = port
    }
  }

  // The handler a Term program hands in is a plain closure and Hummingbird runs requests on a concurrent
  // executor, so it is boxed here rather than captured directly. It is not Sendable, which is the same
  // single-thread constraint the rust target has for the same reason.
  private final class Held: @unchecked Sendable {
    let call: (Request) -> Response
    init(_ call: @escaping (Request) -> Response) {
      self.call = call
    }
  }

  // Run the server and block for the life of the process: the entry point of a server binary.
  static func serve(
    _ port: Int,
    _ host: String,
    _ handler: @escaping (Request) -> Response,
    _ secure: Bool,
    _ certificate: String,
    _ key: String
  ) {
    let waiting = DispatchSemaphore(value: 0)

    Task {
      await run(port, host, Held(handler), secure, certificate, key, nil)
      waiting.signal()
    }

    waiting.wait()
  }

  // Bind the port and answer, without blocking.
  static func start(
    _ port: Int,
    _ host: String,
    _ handler: @escaping (Request) -> Response,
    _ secure: Bool,
    _ certificate: String,
    _ key: String
  ) async -> Running {
    let running = Running(stop: nil, port: port)
    let held = Held(handler)
    let task = Task {
      await run(port, host, held, secure, certificate, key, nil)
    }

    running.stop = { task.cancel() }

    // give the listener a moment to bind, so the port is taken by the time this answers
    try? await Task.sleep(nanoseconds: 50_000_000)

    return running
  }

  static func stop(_ server: Running) async {
    server.stop?()
    server.stop = nil
  }

  private static func run(
    _ port: Int,
    _ host: String,
    _ handler: Held,
    _ secure: Bool,
    _ certificate: String,
    _ key: String,
    _ unused: Int?
  ) async {
    let router = Router()

    // ONE catch-all route per method. The Term API routes inside the handler (network/server/route, and the
    // `dock` routing DSL that lowers to a dispatcher), so Hummingbird's router is deliberately not used for
    // dispatch: two routers in one stack is how a request ends up matched twice and answered once.
    let every: [HTTPRequest.Method] = [
      .get, .post, .put, .patch, .delete, .head, .options,
    ]

    for method in every {
      router.on("/**", method: method) {
        (request: Hummingbird.Request, _: BasicRequestContext) async throws
          -> Hummingbird.Response in
        try await answer(request, handler)
      }
    }

    // TLS now works here. It used to be a named gap ("serving plaintext on <port>" to standard error), because
    // Hummingbird's TLS lives in a separate product. HTTP/2 is negotiated by ALPN, so adding HummingbirdHTTP2
    // for network/http2 brought NIOSSL with it, and the gap closed as a side effect.
    var builder = HTTPServerBuilder.http1()

    if secure {
      guard let tls = http2.tlsConfiguration(certificate, key) else {
        FileHandle.standardError.write(
          Data("server tls: certificate or key did not parse\n".utf8)
        )

        return
      }

      do {
        builder = try .tls(.http1(), tlsConfiguration: tls)
      } catch {
        FileHandle.standardError.write(Data("server tls: \(error)\n".utf8))

        return
      }
    }

    let app = Application(
      router: router,
      server: builder,
      configuration: ApplicationConfiguration(
        address: .hostname(host, port: port)
      )
    )

    do {
      try await app.runService()
    } catch {
      FileHandle.standardError.write(
        Data("server: \(error)\n".utf8)
      )
    }
  }

  private static func answer(
    _ request: Hummingbird.Request,
    _ handler: Held
  ) async throws -> Hummingbird.Response {
    var headers = SeedMap<String, String>([:])

    for field in request.headers {
      headers.data[field.name.canonicalName] = field.value
    }

    // the WHOLE body, however many chunks it arrived in. The old shim took the first read and called it the body.
    var whole = ByteBuffer()

    for try await chunk in request.body {
      var chunk = chunk
      whole.writeBuffer(&chunk)
    }

    let target = request.uri.string
    let answered = handler.call(
      Request(
        method: request.method.rawValue,
        url: target,
        path: request.uri.path,
        query: request.uri.query ?? "",
        headers: headers,
        body: String(buffer: whole),
        dock: 0
      )
    )

    var out = HTTPFields()

    // appended, not set, so repeats survive: several set-cookie headers is the ordinary case and the reason the
    // Term response holds a LIST of headers rather than a map
    for header in answered.headers.data {
      if let name = HTTPField.Name(header.name) {
        out.append(HTTPField(name: name, value: header.value))
      }
    }

    return Hummingbird.Response(
      status: HTTPResponse.Status(code: answered.status),
      headers: out,
      body: ResponseBody(byteBuffer: ByteBuffer(string: answered.body))
    )
  }
}
