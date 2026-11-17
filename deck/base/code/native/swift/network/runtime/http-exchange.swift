import Foundation

// HTTP over URLSession: whole requests, and exchanges held by number. `request` sends a text body and answers `ok`,
// the status, the body as text, then each response header as a lower-case name and its value. `open` sends the
// request, its body as bytes (none when empty), redirects followed only under `follow` (else a task delegate that
// declines each one, so the redirect is answered as it is), and answers `ok`, the exchange's number, the status, then
// each response header the same way. Either answers `timeout` / `outage` and the host's message instead. An exchange's
// body stays unread: `read` takes up to `room` bytes of it, `fault` says after each read whether it broke off (and lets
// go of an exchange whose body ended), `cancel` cancels its task unread.
//
// The timeout is one deadline over the whole answer, from the call to the body's last byte, as on node and rust
// (decision 179 rule 7, item term-self-host-001-1585): an `HttpDeadline` armed at the call, which cancels whatever is
// still waiting when it passes, so each read gets only what is left of it. URLSession's own timeoutInterval counts
// between two arrivals (a stall limit); it is set to the same milliseconds, so it never ends a request the deadline
// would not. The public http module (base/code/network/http.tree) raises from these, so every backend answers alike.

// one deadline, armed when made: when it passes it marks itself passed and runs every cancel handed to it (each at
// once when it has already passed). `stop` disarms it once the answer is whole or let go
final class HttpDeadline: @unchecked Sendable {
  let ms: Int
  private let lock = NSLock()
  private var passedNow = false
  private var stopped = false
  private var cancels: [@Sendable () -> Void] = []
  private var item: DispatchWorkItem?

  init(_ ms: Int) {
    self.ms = max(0, ms)
    let item = DispatchWorkItem { [self] in self.pass() }
    self.item = item
    DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(self.ms), execute: item)
  }

  var passed: Bool {
    lock.lock()
    defer { lock.unlock() }
    return passedNow
  }

  func onPass(_ cancel: @escaping @Sendable () -> Void) {
    lock.lock()
    if passedNow {
      lock.unlock()
      cancel()
      return
    }
    if !stopped { cancels.append(cancel) }
    lock.unlock()
  }

  private func pass() {
    lock.lock()
    if stopped || passedNow {
      lock.unlock()
      return
    }
    passedNow = true
    let all = cancels
    cancels = []
    lock.unlock()
    for cancel in all { cancel() }
  }

  func stop() {
    lock.lock()
    stopped = true
    cancels = []
    let armed = item
    item = nil
    lock.unlock()
    armed?.cancel()
  }

  var answer: [String] { ["timeout", "timed out after \(ms) ms"] }
}

// what a waiting Task answers, carried out of it whole: URLSession's answers are not all Sendable on every SDK
final class HttpAnswered<Value>: @unchecked Sendable {
  let value: Value
  init(_ value: Value) { self.value = value }
}

final class HttpExchangeHeld: @unchecked Sendable {
  var bytes: URLSession.AsyncBytes.AsyncIterator?
  let task: URLSessionDataTask
  let deadline: HttpDeadline
  var done = false
  var fault = ["", ""]
  init(_ bytes: URLSession.AsyncBytes.AsyncIterator, _ task: URLSessionDataTask, _ deadline: HttpDeadline) {
    self.bytes = bytes
    self.task = task
    self.deadline = deadline
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

  private static func made(_ method: String, _ address: URL, _ header: SeedMap<String, String>, _ timeout: Int) -> URLRequest {
    var request = URLRequest(url: address)
    request.httpMethod = method
    request.timeoutInterval = Double(max(0, timeout)) / 1000
    for (name, value) in header.data { request.setValue(value, forHTTPHeaderField: name) }
    return request
  }

  static func request(_ method: String, _ url: String, _ body: String, _ header: SeedMap<String, String>, _ timeout: Int) async -> [String] {
    guard let address = URL(string: url) else { return ["outage", "not a url: \(url)"] }
    var request = made(method, address, header, timeout)
    if !body.isEmpty { request.httpBody = body.data(using: .utf8) }
    let asked = request
    let deadline = HttpDeadline(timeout)
    let waiting = Task { HttpAnswered(try await URLSession.shared.data(for: asked)) }
    deadline.onPass { waiting.cancel() }
    do {
      let (data, response) = try await waiting.value.value
      let late = deadline.passed
      deadline.stop()
      if late { return deadline.answer }
      let answer = response as? HTTPURLResponse
      var out = ["ok", String(answer?.statusCode ?? 0), String(decoding: data, as: UTF8.self)]
      for (name, value) in answer?.allHeaderFields ?? [:] {
        out.append(String(describing: name).lowercased())
        out.append(String(describing: value))
      }
      return out
    } catch {
      let late = deadline.passed
      deadline.stop()
      return late ? deadline.answer : failed(error)
    }
  }

  static func open(_ method: String, _ url: String, _ body: Data, _ header: SeedMap<String, String>, _ timeout: Int, _ follow: Bool) async -> [String] {
    guard let address = URL(string: url) else { return ["outage", "not a url: \(url)"] }
    var request = made(method, address, header, timeout)
    if !body.isEmpty { request.httpBody = body }
    let asked = request
    let deadline = HttpDeadline(timeout)
    let waiting = Task { HttpAnswered(try await URLSession.shared.bytes(for: asked, delegate: follow ? nil : HttpExchangeStay())) }
    deadline.onPass { waiting.cancel() }
    do {
      let (bytes, response) = try await waiting.value.value
      if deadline.passed {
        deadline.stop()
        bytes.task.cancel()
        return deadline.answer
      }
      let answer = response as? HTTPURLResponse
      let one = HttpExchangeHeld(bytes.makeAsyncIterator(), bytes.task, deadline)
      // from here the deadline ends the body: a read waiting on it then breaks off
      deadline.onPass { one.task.cancel() }
      let ticket = keep(one)
      var out = ["ok", String(ticket), String(answer?.statusCode ?? 0)]
      for (name, value) in answer?.allHeaderFields ?? [:] {
        out.append(String(describing: name).lowercased())
        out.append(String(describing: value))
      }
      return out
    } catch {
      let late = deadline.passed
      deadline.stop()
      return late ? deadline.answer : failed(error)
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
      one.deadline.stop()
      return Data()
    }
    one.bytes = nil
    // the deadline passed before this read: nothing is left of it
    if one.deadline.passed {
      one.fault = one.deadline.answer
      one.done = true
      one.task.cancel()
      return Data()
    }
    var out = Data()
    do {
      while out.count < room {
        guard let byte = try await bytes.next() else {
          one.done = true
          // the body ended, but only after the deadline: as late as one that never ended
          if one.deadline.passed {
            one.fault = one.deadline.answer
            return Data()
          }
          one.deadline.stop()
          return out
        }
        out.append(byte)
      }
      one.bytes = bytes
    } catch {
      one.fault = one.deadline.passed ? one.deadline.answer : failed(error)
      one.done = true
      one.deadline.stop()
    }
    return out
  }

  static func fault(_ ticket: Int) -> [String] {
    guard let one = find(ticket) else { return ["gone", "no exchange \(ticket) is held"] }
    if one.done { _ = letGo(ticket) }
    return one.fault
  }

  static func cancel(_ ticket: Int) {
    guard let one = letGo(ticket) else { return }
    one.deadline.stop()
    one.task.cancel()
  }
}
