import Foundation

enum http {
    // `header` is a map of name to value and may be empty. Written to match
    // the node runtime, and NOT exercised here: this repository builds and
    // tests the node target only.
    static func request(_ method: String, _ url: String, _ body: String, _ header: SeedMap<String, String>) async -> HttpResponse {
        let header = header.data
        guard let u = URL(string: url) else { return HttpResponse(status: 0, body: "") }
        var req = URLRequest(url: u)
        req.httpMethod = method
        for (name, value) in header { req.setValue(value, forHTTPHeaderField: name) }
        if !body.isEmpty { req.httpBody = body.data(using: .utf8) }
        do {
            let (data, response) = try await URLSession.shared.data(for: req)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            return HttpResponse(status: status, body: String(data: data, encoding: .utf8) ?? "")
        } catch {
            return HttpResponse(status: 0, body: "")
        }
    }
}
