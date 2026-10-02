// Over-the-air page updates on Apple (native-dom-0016): the client half. The publisher is deck/call/code/update.ts,
// which documents the layout. Reached through ../cask.tree as `caskUpdate.launchPath`, `caskUpdate.check`,
// `caskUpdate.ready`.
//
// What a launch does, in Expo's order (expo-updates AppLoaderTask.swift, read 2026-10-02):
//
//   1. a launch that never reached its first render marks the update it ran as bad, and the next launch does not
//      run it again. The embedded page is always the floor
//   2. the newest downloaded update that matches this binary's runtime version and is not bad is the page to load
//   3. in the background, the newest published update for this platform, runtime version and channel is fetched,
//      its signature checked against the key inside the app, its runtime version checked again, every asset
//      checked against its hash, staged, and swapped in whole. It is used from the NEXT launch, never under a page
//      already running
//
// Nothing here trusts the network: a manifest is used only after its exact bytes verify against the app's own key, and
// an asset only after its sha256 equals the one the signed manifest names. A file:// base works as well as https://,
// which is how the tests serve updates.
import CryptoKit
import Foundation
import Security

enum caskUpdate {
    // what the runtime knows about this binary, all of it shipped inside the app at build time
    private static func embeddedVersion(_ resources: String) -> String {
        (try? String(contentsOfFile: "\(resources)/runtime-version", encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private static func platform() -> String {
        #if os(iOS)
        return "ios"
        #else
        return "macos"
        #endif
    }

    private static func updates(_ data: String) -> URL {
        URL(fileURLWithPath: data, isDirectory: true).appendingPathComponent("updates", isDirectory: true)
    }

    private static func read(_ url: URL) -> String? {
        (try? String(contentsOf: url, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func bad(_ data: String) -> Set<String> {
        Set((read(updates(data).appendingPathComponent("bad")) ?? "").split(separator: "\n").map(String.init))
    }

    private static func markBad(_ data: String, _ id: String) {
        let file = updates(data).appendingPathComponent("bad")
        let lines = (read(file) ?? "").split(separator: "\n").map(String.init) + [id]
        try? lines.joined(separator: "\n").write(to: file, atomically: true, encoding: .utf8)
    }

    // the page directory to load: `resources/page` as shipped, or the newest good update. Also records which update
    // this launch runs, so a crash before `ready` is known about at the next launch
    static func launchPath(_ resources: String, _ page: String, _ data: String) -> String {
        let embedded = "\(resources)/\(page)"
        let root = updates(data)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let launching = root.appendingPathComponent("launching")

        // step 1: the last launch never reached its first render. Its update is bad, and if it was the current one,
        // nothing is current: the shipped page runs until a newer good update arrives
        if let failed = read(launching), !failed.isEmpty {
            markBad(data, failed)
            if read(root.appendingPathComponent("current")) == failed {
                try? FileManager.default.removeItem(at: root.appendingPathComponent("current"))
            }
            try? FileManager.default.removeItem(at: launching)
        }

        // step 2
        guard let id = read(root.appendingPathComponent("current")), !id.isEmpty, !bad(data).contains(id) else {
            return embedded
        }
        let dir = root.appendingPathComponent(id, isDirectory: true)
        guard read(dir.appendingPathComponent(".runtime-version")) == embeddedVersion(resources),
              FileManager.default.fileExists(atPath: dir.appendingPathComponent("index.html").path)
        else {
            return embedded
        }
        try? id.write(to: launching, atomically: true, encoding: .utf8)
        return dir.path
    }

    // the first render happened: whatever this launch ran is good
    static func ready(_ data: String) {
        try? FileManager.default.removeItem(at: updates(data).appendingPathComponent("launching"))
    }

    // `sig=":<base64>:", keyid="root", alg="rsa-v1_5-sha256"`, the form the publisher writes
    private static func signature(_ header: String) -> Data? {
        guard let start = header.range(of: "sig=\":"),
              let end = header.range(of: ":\"", range: start.upperBound..<header.endIndex)
        else { return nil }
        return Data(base64Encoded: String(header[start.upperBound..<end.lowerBound]))
    }

    private static func verified(_ manifest: Data, _ header: String, _ resources: String) -> Bool {
        guard let der = FileManager.default.contents(atPath: "\(resources)/update-key.der"),
              let sig = signature(header),
              let key = SecKeyCreateWithData(
                der as CFData,
                [kSecAttrKeyType: kSecAttrKeyTypeRSA, kSecAttrKeyClass: kSecAttrKeyClassPublic] as CFDictionary,
                nil
              )
        else { return false }
        return SecKeyVerifySignature(key, .rsaSignatureMessagePKCS1v15SHA256, manifest as CFData, sig as CFData, nil)
    }

    // base64url sha256, the manifest's encoding
    private static func hash(_ bytes: Data) -> String {
        Data(SHA256.hash(data: bytes))
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func fetch(_ url: URL) -> Data? {
        let done = DispatchSemaphore(value: 0)
        var body: Data?
        URLSession.shared.dataTask(with: url) { data, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 200
            body = status == 200 ? data : nil
            done.signal()
        }.resume()
        done.wait()
        return body
    }

    // fetch, check and stage the newest update, off the main thread, then call `done` ON THE MAIN THREAD with what
    // happened: `none`, `current`, `applied <id>`, or `refused: <reason>`. Never touches the page that is running. The
    // main thread, because what a program does next is usually open a window or load a page, which AppKit and UIKit
    // allow only there
    static func check(_ resources: String, _ data: String, _ base: String, _ channel: String, _ done: @escaping (String) -> Void) {
        DispatchQueue.global(qos: .utility).async {
            let status = apply(resources, data, base, channel)
            // CASK_TRACE=1 prints what every check concluded, the way the cask runtime prints the bridge
            if ProcessInfo.processInfo.environment["CASK_TRACE"] != nil {
                print("cask update: \(status)")
            }
            DispatchQueue.main.async { done(status) }
        }
    }

    private static func apply(_ resources: String, _ data: String, _ base: String, _ channel: String) -> String {
        let version = embeddedVersion(resources)
        guard !version.isEmpty, let root = URL(string: base.hasSuffix("/") ? base : "\(base)/") else {
            return "refused: no runtime version in the app"
        }
        let manifestURL = root.appendingPathComponent("\(platform())/\(version)/\(channel).json")
        guard let manifest = fetch(manifestURL) else { return "none" }
        guard let header = fetch(manifestURL.appendingPathExtension("sig")).flatMap({ String(data: $0, encoding: .utf8) }),
              verified(manifest, header, resources)
        else { return "refused: the signature does not verify" }
        guard let json = try? JSONSerialization.jsonObject(with: manifest) as? [String: Any],
              let id = json["id"] as? String,
              let launch = json["launchAsset"] as? [String: Any],
              let rest = json["assets"] as? [[String: Any]]
        else { return "refused: not a manifest" }
        guard json["runtimeVersion"] as? String == version else {
            return "refused: built for another runtime version"
        }
        let store = updates(data)
        // a bad update is refused before anything else is asked of it
        if bad(data).contains(id) { return "refused: \(id) failed a launch" }
        if read(store.appendingPathComponent("current")) == id { return "current" }

        // staged under a name no launch reads, swapped in only once every asset is there and checks
        let staging = store.appendingPathComponent(".staging-\(id)", isDirectory: true)
        try? FileManager.default.removeItem(at: staging)
        for asset in [launch] + rest {
            guard let key = asset["key"] as? String, let path = asset["url"] as? String, let want = asset["hash"] as? String,
                  !key.contains(".."), !key.hasPrefix("/"),
                  let bytes = fetch(root.appendingPathComponent(path))
            else { return "refused: an asset could not be fetched" }
            guard hash(bytes) == want else { return "refused: \(key) does not match its hash" }
            let target = staging.appendingPathComponent(key)
            try? FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            guard (try? bytes.write(to: target)) != nil else { return "refused: \(key) could not be written" }
        }
        try? version.write(to: staging.appendingPathComponent(".runtime-version"), atomically: true, encoding: .utf8)
        let final = store.appendingPathComponent(id, isDirectory: true)
        try? FileManager.default.removeItem(at: final)
        guard (try? FileManager.default.moveItem(at: staging, to: final)) != nil else {
            return "refused: the update could not be moved into place"
        }
        try? id.write(to: store.appendingPathComponent("current"), atomically: true, encoding: .utf8)
        return "applied \(id)"
    }
}
