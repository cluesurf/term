import Foundation

enum http {
    static func request(_ method: String, _ url: String, _ body: String) async -> HttpResponse {
        guard let u = URL(string: url) else { return HttpResponse(status: 0, body: "") }
        var req = URLRequest(url: u)
        req.httpMethod = method
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
