// A download on AppKit and UIKit (beat-term-0004), docked by ../download.tree as `<global:native-download>`. URLSession
// downloads to a temporary file of its own, and only a 2xx answer moves it over the path, so a failed download leaves
// what was there. A minute without a byte gives up.

import Foundation

enum nativeDownload {
    // `downloaded <bytes>`, `failed <status>`, or `failed 0` with no answer
    static func fetch(_ address: String, _ path: String) async -> String {
        guard let url = URL(string: address), url.scheme == "http" || url.scheme == "https" else { return "failed 0" }
        var request = URLRequest(url: url)
        request.timeoutInterval = 60
        let fetched: (URL, URLResponse)
        do {
            fetched = try await URLSession.shared.download(for: request)
        } catch {
            return "failed 0"
        }
        let status = (fetched.1 as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            try? FileManager.default.removeItem(at: fetched.0)
            return "failed \(status)"
        }
        let target = URL(fileURLWithPath: path)
        do {
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: path) {
                _ = try FileManager.default.replaceItemAt(target, withItemAt: fetched.0)
            } else {
                try FileManager.default.moveItem(at: fetched.0, to: target)
            }
        } catch {
            return "failed 0"
        }
        let bytes = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? 0
        return "downloaded \(bytes)"
    }
}
