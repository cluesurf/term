// HTTP/2 server runtime for the swift target, over HummingbirdHTTP2 (swift-nio-http2 underneath).
//
// TWO WAYS IN, and Hummingbird has a builder for each:
//
//   secure   `HTTPServerBuilder.http2Upgrade(tlsConfiguration:)`, TLS with ALPN advertising h2, falling back to
//            HTTP/1.1 for a client that cannot do h2. This is the only way a browser speaks HTTP/2.
//   clear    `HTTPServerBuilder.plaintextHTTP2()`, h2c with prior knowledge: no ALPN, no upgrade dance.
//
// Adding this product is also what gives the swift target TLS AT ALL: h2 is negotiated by ALPN, so the HTTP/2
// package IS the TLS package (NIOSSL). network/runtime/server.swift uses it too now, and no longer serves
// plaintext while apologising for it.
//
// Reached only through the public network/http2 API. See note/term/stdlib/native-async-file-and-server.md.
import Foundation
import HTTPTypes
import Hummingbird
import HummingbirdCore
import HummingbirdHTTP2
import NIOCore
import NIOPosix
import NIOSSL

enum http2 {
  final class Running: @unchecked Sendable {
    var stop: (() -> Void)?
    let port: Int
    init(stop: (() -> Void)?, port: Int) {
      self.stop = stop
      self.port = port
    }
  }

  // the handler is boxed because Hummingbird runs requests on a concurrent executor and a Term task value is not
  // Sendable: the same single-thread constraint the rust target has, for the same reason
  private final class Held: @unchecked Sendable {
    let call: (Request) -> Response
    init(_ call: @escaping (Request) -> Response) {
      self.call = call
    }
  }

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
      await run(port, host, Held(handler), secure, certificate, key)
      waiting.signal()
    }

    waiting.wait()
  }

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
      await run(port, host, held, secure, certificate, key)
    }

    running.stop = { task.cancel() }

    // let the listener bind, so the port is taken by the time this answers
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
    _ key: String
  ) async {
    let router = Router()
    let every: [HTTPRequest.Method] = [
      .get, .post, .put, .patch, .delete, .head, .options,
    ]

    // ONE catch-all route per method: the Term API routes inside the handler, so Hummingbird's router is not
    // used for dispatch. Two routers in one stack is how a request is matched twice and answered once.
    for method in every {
      router.on("/**", method: method) {
        (request: Hummingbird.Request, _: BasicRequestContext) async throws
          -> Hummingbird.Response in
        try await answer(request, handler, secure ? "https" : "http")
      }
    }

    let builder: HTTPServerBuilder

    if secure {
      guard let tls = tlsConfiguration(certificate, key) else {
        FileHandle.standardError.write(
          Data("http2 tls: certificate or key did not parse\n".utf8)
        )

        return
      }

      do {
        builder = try .http2Upgrade(tlsConfiguration: tls)
      } catch {
        FileHandle.standardError.write(Data("http2 tls: \(error)\n".utf8))

        return
      }
    } else {
      builder = .plaintextHTTP2()
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
      FileHandle.standardError.write(Data("http2: \(error)\n".utf8))
    }
  }

  // a NIOSSL configuration that ADVERTISES h2 over ALPN, which is the whole difference from the HTTP/1.1 one
  static func tlsConfiguration(
    _ certificate: String,
    _ key: String
  ) -> TLSConfiguration? {
    do {
      let chain = try NIOSSLCertificate.fromPEMBytes(Array(certificate.utf8))
        .map { NIOSSLCertificateSource.certificate($0) }
      let private_ = try NIOSSLPrivateKey(bytes: Array(key.utf8), format: .pem)
      var tls = TLSConfiguration.makeServerConfiguration(
        certificateChain: chain,
        privateKey: .privateKey(private_)
      )
      tls.applicationProtocols = ["h2", "http/1.1"]

      return tls
    } catch {
      return nil
    }
  }

  private static func answer(
    _ request: Hummingbird.Request,
    _ handler: Held,
    _ scheme: String
  ) async throws -> Hummingbird.Response {
    let headers = SeedMap<String, String>([:])

    for field in request.headers {
      headers.data[field.name.canonicalName] = field.value
    }

    var whole = ByteBuffer()

    for try await chunk in request.body {
      var chunk = chunk
      whole.writeBuffer(&chunk)
    }

    let target = request.uri.string
    let path = request.uri.path

    // the pseudo-headers, in the SAME map the HTTP/1.1 server fills, which is what lets one handler serve both
    headers.data[":method"] = request.method.rawValue
    headers.data[":scheme"] = scheme
    headers.data[":authority"] =
      request.uri.host ?? headers.data["host"] ?? ""
    headers.data[":path"] = path
    // Hummingbird does not surface the stream id to a responder, so it is reported as 0 rather than invented
    headers.data["x-term-stream"] = "0"

    let answered = handler.call(
      Request(
        method: request.method.rawValue,
        url: target,
        path: path,
        query: request.uri.query ?? "",
        headers: headers,
        body: String(buffer: whole),
        dock: 0
      )
    )

    var out = HTTPFields()

    for header in answered.headers.data {
      // RFC 9113 forbids the connection-specific fields; a response carrying one is malformed
      if isConnectionHeader(header.name) {
        continue
      }

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

  private static func isConnectionHeader(_ name: String) -> Bool {
    switch name.lowercased() {
    case "connection", "keep-alive", "proxy-connection", "transfer-encoding",
      "upgrade":
      return true
    default:
      return false
    }
  }
}
