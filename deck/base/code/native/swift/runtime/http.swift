import Foundation

// The one HTTP primitive over URLSession. Answers a flat list of text: `ok`, the status, the body, then each response
// header as a lower-case name and its value; or `timeout` / `outage` and the host's message. The public http module
// (base/code/network/http.tree) builds the response from it, so every backend answers alike.
enum http {
    static func request(_ method: String, _ url: String, _ body: String, _ header: SeedMap<String, String>, _ timeout: Int) async -> [String] {
        guard let address = URL(string: url) else { return ["outage", "not a url: \(url)"] }
        var request = URLRequest(url: address)
        request.httpMethod = method
        request.timeoutInterval = Double(max(0, timeout)) / 1000
        for (name, value) in header.data { request.setValue(value, forHTTPHeaderField: name) }
        if !body.isEmpty { request.httpBody = body.data(using: .utf8) }
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let answer = response as? HTTPURLResponse
            var out = ["ok", String(answer?.statusCode ?? 0), String(decoding: data, as: UTF8.self)]
            for (name, value) in answer?.allHeaderFields ?? [:] {
                out.append(String(describing: name).lowercased())
                out.append(String(describing: value))
            }
            return out
        } catch let error as URLError where error.code == .timedOut {
            return ["timeout", "\(error)"]
        } catch {
            return ["outage", "\(error)"]
        }
    }
}
