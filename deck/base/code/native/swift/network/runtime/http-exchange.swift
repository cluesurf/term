import Foundation

// HTTP exchanges over URLSession's byte stream, held by number. `open` sends the request, its body as bytes (none when
// empty), redirects followed only under `follow` (else a task delegate that declines each one, so the redirect is
// answered as it is), and answers `ok`, the exchange's number, the status, then each response header as a lower-case
// name and its value; or `timeout` / `outage` and the host's message. The body stays unread: `read` takes up to `room`
// bytes of it, `fault` says after each read whether it broke off (and lets go of an exchange whose body ended),
// `cancel` cancels its task unread. The time limit is the request's timeoutInterval, which URLSession counts between
// two arrivals. The public http module (base/code/network/http.tree) raises from these, so every backend answers alike.
final class HttpExchangeHeld: @unchecked Sendable {
  var bytes: URLSession.AsyncBytes.AsyncIterator?
  let task: URLSessionDataTask
  var done = false
  var fault = ["", ""]
  init(_ bytes: URLSession.AsyncBytes.AsyncIterator, _ task: URLSessionDataTask) {
    self.bytes = bytes
    self.task = task
  }
}

// declines every redirect, so URLSession answers it as it is
final class HttpExchangeStay: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest
  ) async -> URLRequest? {
    return nil
  }
}

enum httpExchange {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var held: [Int: HttpExchangeHeld] = [:]
  nonisolated(unsafe) private static var next = 0

  private static func failed(_ error: Error) -> [String] {
    if let error = error as? URLError, error.code == .timedOut {
      return ["timeout", "\(error)"]
    }
    return ["outage", "\(error)"]
  }

  private static func keep(_ one: HttpExchangeHeld) -> Int {
    lock.lock()
    defer { lock.unlock() }
    next += 1
    held[next] = one
    return next
  }

  private static func find(_ ticket: Int) -> HttpExchangeHeld? {
    lock.lock()
    defer { lock.unlock() }
    return held[ticket]
  }

  private static func letGo(_ ticket: Int) -> HttpExchangeHeld? {
    lock.lock()
    defer { lock.unlock() }
    return held.removeValue(forKey: ticket)
  }

  static func open(_ method: String, _ url: String, _ body: Data, _ header: SeedMap<String, String>, _ timeout: Int, _ follow: Bool) async -> [String] {
    guard let address = URL(string: url) else { return ["outage", "not a url: \(url)"] }
    var request = URLRequest(url: address)
    request.httpMethod = method
    request.timeoutInterval = Double(max(0, timeout)) / 1000
    for (name, value) in header.data { request.setValue(value, forHTTPHeaderField: name) }
    if !body.isEmpty { request.httpBody = body }
    do {
      let (bytes, response) = try await URLSession.shared.bytes(for: request, delegate: follow ? nil : HttpExchangeStay())
      let answer = response as? HTTPURLResponse
      let ticket = keep(HttpExchangeHeld(bytes.makeAsyncIterator(), bytes.task))
      var out = ["ok", String(ticket), String(answer?.statusCode ?? 0)]
      for (name, value) in answer?.allHeaderFields ?? [:] {
        out.append(String(describing: name).lowercased())
        out.append(String(describing: value))
      }
      return out
    } catch {
      return failed(error)
    }
  }

  static func read(_ ticket: Int, _ room: Int) async -> Data {
    guard let one = find(ticket) else { return Data() }
    // a body already read to its end, asked again: gone, as `fault` then says
    if one.done {
      _ = letGo(ticket)
      return Data()
    }
    guard var bytes = one.bytes else {
      one.done = true
      return Data()
    }
    one.bytes = nil
    var out = Data()
    do {
      while out.count < room {
        guard let byte = try await bytes.next() else {
          one.done = true
          return out
        }
        out.append(byte)
      }
      one.bytes = bytes
    } catch {
      one.fault = failed(error)
      one.done = true
    }
    return out
  }

  static func fault(_ ticket: Int) -> [String] {
    guard let one = find(ticket) else { return ["gone", "no exchange \(ticket) is held"] }
    if one.done { _ = letGo(ticket) }
    return one.fault
  }

  static func cancel(_ ticket: Int) {
    letGo(ticket)?.task.cancel()
  }
}
