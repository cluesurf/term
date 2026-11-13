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
// Reached only through the public network/server API. See note/project/term/stdlib/native-async-file-and-server.md.
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
  // a running server: how to stop it and wait until it has (item 1206), and the port it bound (the OS's choice when
  // port 0 was asked, item 1326)
  final class Running: @unchecked Sendable {
    var stop: (() async -> Void)?
    var port: Int
    init(stop: (() async -> Void)?, port: Int) {
      self.stop = stop
      self.port = port
    }
  }

  // resumed ONCE, by whichever comes first: the listener bound (onServerRunning), or the server's run ended without
  // binding (a refused port, a bad certificate). A second resume of a checked continuation is a crash, hence the flag
  private final class Bound: @unchecked Sendable {
    private let lock = NSLock()
    private var waiting: CheckedContinuation<Void, Never>?
    private var done = false
    // the port the listener is bound to, once it is (item 1326)
    var port: Int?

    func wait() async {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        lock.lock()
        if done {
          lock.unlock()
          continuation.resume()
        } else {
          waiting = continuation
          lock.unlock()
        }
      }
    }

    func signal() {
      lock.lock()
      if done {
        lock.unlock()
        return
      }
      done = true
      let continuation = waiting
      waiting = nil
      lock.unlock()
      continuation?.resume()
    }
  }

  // NO TERM FORM IS NAMED HERE (item term-self-host-001-1218). This file is spliced into the emitted program as
  // source, and a form's name there is not its own: loaded beside network/http, the server's `response` is
  // `Response__in0_1`. The handler is the native module's `answer-plain` over the program's (network/server/plain):
  // the request goes in as its parts (method, url, path, query, headers, body, dock), the response comes back as
  // `[status, body, hex, name, value, ...]`, `hex` a bytes body (item 1326).
  typealias Handler = (String, String, String, String, SeedMap<String, String>, String, Any) -> SeedList<String>

  // The handler a Term program hands in is a plain closure and Hummingbird runs requests on a concurrent
  // executor, so it is boxed here rather than captured directly. It is not Sendable, which is the same
  // single-thread constraint the rust target has for the same reason.
  private final class Held: @unchecked Sendable {
    let call: Handler
    init(_ call: @escaping Handler) {
      self.call = call
    }
  }

  // Run the server and block for the life of the process: the entry point of a server binary.
  static func serve(
    _ port: Int,
    _ host: String,
    _ handler: @escaping Handler,
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
    _ handler: @escaping Handler,
    _ secure: Bool,
    _ certificate: String,
    _ key: String
  ) async -> Running {
    let running = Running(stop: nil, port: port)
    let held = Held(handler)
    let bound = Bound()
    let task = Task {
      await run(port, host, held, secure, certificate, key, bound)
      // a run that ended without binding still lets `start` answer
      bound.signal()
    }

    // stop CANCELS the run and WAITS for it to end: the run returns only once Hummingbird has closed its listening
    // channel, so the port is free when `stop` answers (item 1206). A cancel alone answered at once, with the
    // listener still open, and a second start on the port raced its close
    running.stop = {
      task.cancel()
      await task.value
    }

    // answer once the listener is bound, so the port is taken by the time this answers. A fixed 50 ms sleep stood
    // here, which answered before the bind on a loaded machine and waited for nothing on an idle one
    await bound.wait()
    if let port = bound.port {
      running.port = port
    }

    return running
  }

  // the port a started server is bound to: the OS's choice when `start` asked for port 0 (item 1326)
  static func port(_ server: Running) -> Int {
    return server.port
  }

  static func stop(_ server: Running) async {
    let stop = server.stop
    server.stop = nil
    await stop?()
  }

  // the server's own NIOSSL configuration. It advertises only HTTP/1.1 over ALPN, because this builder speaks only
  // HTTP/1.1: borrowing the http2 shim's, which advertises h2 first, let a browser negotiate a protocol the server
  // then did not speak. It is also why this file no longer names `http2`, which is prepended only for a program that
  // docks it, so a plain server did not build at all
  private static func tlsConfiguration(
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
      tls.applicationProtocols = ["http/1.1"]

      return tls
    } catch {
      return nil
    }
  }

  private static func run(
    _ port: Int,
    _ host: String,
    _ handler: Held,
    _ secure: Bool,
    _ certificate: String,
    _ key: String,
    _ bound: Bound?
  ) async {
    let router = Router()

    // ONE catch-all route per method. The Term API routes inside the handler (network/server/route, and the
    // `dock` routing DSL that lowers to a dispatcher), so Hummingbird's router is deliberately not used for
    // dispatch: two routers in one stack is how a request ends up matched twice and answered once.
    let every: [HTTPRequest.Method] = [
      .get, .post, .put, .patch, .delete, .head, .options,
    ]

    // "/**" matches one segment or more, never the root, so "/" has its own route (item term-self-host-001-1218): a
    // GET of "/" answered Hummingbird's own 404 and never reached the handler
    for method in every {
      router.on("/", method: method) {
        (request: Hummingbird.Request, _: BasicRequestContext) async throws
          -> Hummingbird.Response in
        try await answer(request, handler)
      }
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
      guard let tls = tlsConfiguration(certificate, key) else {
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
      ),
      onServerRunning: { channel in
        bound?.port = channel.localAddress?.port
        bound?.signal()
      }
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
    let said = handler.call(
      request.method.rawValue,
      target,
      request.uri.path,
      request.uri.query ?? "",
      headers,
      String(buffer: whole),
      0
    ).data

    // `[status, body, hex, name, value, ...]`; a status that does not read as one is a 500
    var status = 500
    if let first = said.first, let read = Double(first.trimmingCharacters(in: .whitespaces)),
      read >= 100, read <= 999
    {
      status = Int(read)
    }
    // a bytes body comes as hex, two digits a byte, and is sent as those bytes; a text body as its utf8 (item 1326)
    let hex = said.count > 2 ? said[2] : ""
    let body = hex.isEmpty ? ByteBuffer(string: said.count > 1 ? said[1] : "") : ByteBuffer(bytes: unhex(hex))
    var out = HTTPFields()

    // appended, not set, so repeats survive: several set-cookie headers is the ordinary case and the reason the
    // Term response holds a LIST of headers rather than a map
    var at = 3
    while at + 1 < said.count {
      if let name = HTTPField.Name(said[at]) {
        out.append(HTTPField(name: name, value: said[at + 1]))
      }
      at += 2
    }

    return Hummingbird.Response(
      status: HTTPResponse.Status(code: status),
      headers: out,
      body: ResponseBody(byteBuffer: body)
    )
  }

  // bytes from their hex, two digits a byte, as network/server/plain writes a bytes body
  private static func unhex(_ text: String) -> [UInt8] {
    func digit(_ at: UInt8) -> UInt8 {
      switch at {
      case 48...57: return at - 48
      case 97...102: return at - 87
      case 65...70: return at - 55
      default: return 0
      }
    }
    let raw = Array(text.utf8)
    var out = [UInt8]()
    out.reserveCapacity(raw.count / 2)
    var at = 0
    while at + 1 < raw.count {
      out.append((digit(raw[at]) << 4) | digit(raw[at + 1]))
      at += 2
    }

    return out
  }
}
