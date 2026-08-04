// HTTP request runtime. URLSession's async calls throw and return tuples, neither of which the seed source can
// destructure, so each call is wrapped to return just the value the caller wants and to surface a failure as an empty
// result rather than a thrown error. Reached only through the public network API.
import Foundation

enum request {
    static func send(_ url: String) async -> String {
        guard let target = URL(string: url) else { return "" }

        do {
            let (data, _) = try await URLSession.shared.data(from: target)

            return String(data: data, encoding: .utf8) ?? ""
        } catch {
            return ""
        }
    }

    static func upload(_ url: String, _ body: String) async -> String {
        guard let target = URL(string: url) else { return "" }

        var message = URLRequest(url: target)
        message.httpMethod = "POST"

        do {
            let (data, _) = try await URLSession.shared.upload(
                for: message,
                from: Data(body.utf8)
            )

            return String(data: data, encoding: .utf8) ?? ""
        } catch {
            return ""
        }
    }

    // returns the downloaded file's local path, empty when the download failed
    static func download(_ url: String) async -> String {
        guard let target = URL(string: url) else { return "" }

        do {
            let (local, _) = try await URLSession.shared.download(from: target)

            return local.path
        } catch {
            return ""
        }
    }
}
