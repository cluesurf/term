import Foundation
// The cask runtime on Apple: one AppKit window holding one WKWebView, a script message handler that receives what
// the page posts through `window.term.post(text)`, and `eval` to answer it. Reached only through the public cask API.
//
// Two rules the WebView imposes and this file honours. Every call into WKWebView happens on the main thread, so
// `eval` hops there. The bridge shim is injected at document start so the page finds `window.term` before its own
// script runs, which is what wry does for `window.ipc` (land/code/github.com/tauri-apps/wry/src/wkwebview/mod.rs:642).
//
// The Term-facing names are the tasks in ../cask.tree: `cask.openWindow`, `cask.loadBundle`, `cask.loadUrl`,
// `cask.eval`, `cask.onMessage`, `cask.run`, `cask.quit`, `cask.bundlePath`, `cask.dataPath`.
import AppKit
import Foundation
import WebKit

// what the page sees. `window.term.post` is the one way in; the reply and every pushed event come back through
// `eval`. Frozen so a page script cannot swap it for a spy.
private let BRIDGE_SHIM = """
Object.defineProperty(window, 'term', { value: {
  post: function (text) { window.webkit.messageHandlers.term.postMessage(String(text)) },
  reply: function (message) { if (window.term.onReply) { window.term.onReply(message) } },
  onReply: null
} });
Object.freeze(window.term.post);
"""

// the name the page posts to and the handler is registered under
private let BRIDGE_NAME = "term"

// receives every `window.term.post`. One per window, holding the handler the Term program registered. The handler
// is asynchronous and answers with the reply text; the reply goes back into the page on the main thread, which is
// the one thread WKWebView accepts a script from
final class CaskBridge: NSObject, WKScriptMessageHandler {
    var onMessage: ((String) async -> String)?
    weak var webview: WKWebView?

    func userContentController(
        _ controller: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let text = message.body as? String, let handler = onMessage else { return }
        // CASK_TRACE=1 in the environment prints every message and reply, which is how a stuck bridge is read
        let trace = ProcessInfo.processInfo.environment["CASK_TRACE"] != nil
        if trace { print("cask <- \(text)") }
        Task {
            let reply = await handler(text)
            if trace { print("cask -> \(reply)") }
            await MainActor.run {
                self.webview?.evaluateJavaScript("window.term.reply(\(reply))", completionHandler: nil)
            }
        }
    }
}

// keeps the app alive after the last window closes only as long as the program wants; a one-window cask quits
final class CaskDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

}

// tells the Term program when the page has finished loading, which is when `eval` and `snapshot` mean something
final class CaskNavigation: NSObject, WKNavigationDelegate {
    var onReady: (() -> Void)?

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        onReady?()
    }
}

// one window and the WebView inside it. The opaque handle Term holds
final class CaskWindow {
    let window: NSWindow
    let webview: WKWebView
    let bridge: CaskBridge
    let navigation: CaskNavigation

    init(window: NSWindow, webview: WKWebView, bridge: CaskBridge, navigation: CaskNavigation) {
        self.window = window
        self.webview = webview
        self.bridge = bridge
        self.navigation = navigation
    }
}

enum cask {
    private static let delegate = CaskDelegate()

    // the app object, made once on first use, with the delegate that lets a closed window end the process
    private static func app() -> NSApplication {
        let app = NSApplication.shared
        if app.delegate == nil {
            app.setActivationPolicy(.regular)
            app.delegate = delegate
        }
        return app
    }

    // Term's `number` is `Int` on this backend, so the size arrives as integers
    static func openWindow(_ title: String, _ width: Int, _ height: Int) -> CaskWindow {
        _ = app()

        let bridge = CaskBridge()
        let controller = WKUserContentController()
        controller.add(bridge, name: BRIDGE_NAME)
        controller.addUserScript(
            WKUserScript(source: BRIDGE_SHIM, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )

        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        // a bundle is loaded from the app's own files, and a page loaded from a file URL may fetch its siblings
        configuration.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")

        let frame = NSRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height))
        let webview = WKWebView(frame: frame, configuration: configuration)
        webview.autoresizingMask = [.width, .height]
        let navigation = CaskNavigation()
        webview.navigationDelegate = navigation
        bridge.webview = webview

        let window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = title
        window.contentView = webview
        window.center()
        // NOT on screen yet. A test that only talks over the bridge never shows anything; `show` puts the window
        // on screen behind everything, `activate` brings it to the front with focus
        // the handle owns the window; without this AppKit releases it when the last reference goes
        window.isReleasedWhenClosed = false

        return CaskWindow(window: window, webview: webview, bridge: bridge, navigation: navigation)
    }

    // `path` is the directory holding index.html; the page may read its siblings and nothing above them
    static func loadBundle(_ handle: CaskWindow, _ path: String) {
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        let index = directory.appendingPathComponent("index.html")
        DispatchQueue.main.async {
            handle.webview.loadFileURL(index, allowingReadAccessTo: directory)
        }
    }

    static func loadUrl(_ handle: CaskWindow, _ url: String) {
        guard let parsed = URL(string: url) else { return }
        DispatchQueue.main.async {
            handle.webview.load(URLRequest(url: parsed))
        }
    }

    // always on the main thread, which is the one rule WKWebView enforces
    static func eval(_ handle: CaskWindow, _ script: String) {
        DispatchQueue.main.async {
            handle.webview.evaluateJavaScript(script, completionHandler: nil)
        }
    }

    static func onMessage(_ handle: CaskWindow, _ handler: @escaping (String) async -> String) {
        handle.bridge.onMessage = handler
    }

    // leave with a status the caller of the process can read. The smoke test's verdict
    static func exit(_ status: Int) {
        Foundation.exit(Int32(status))
    }

    // fires once per load, after the page has finished. Registered before `load-bundle` so the first load is seen
    static func onReady(_ handle: CaskWindow, _ handler: @escaping () -> Void) {
        handle.navigation.onReady = handler
    }

    // writes a PNG of the page as drawn to `path`, then calls `done`. The proof of a build on every platform, and
    // independent of which display the window landed on
    static func snapshot(_ handle: CaskWindow, _ path: String, _ done: @escaping () -> Void) {
        DispatchQueue.main.async {
            handle.webview.takeSnapshot(with: nil) { image, _ in
                if let image = image,
                   let tiff = image.tiffRepresentation,
                   let bitmap = NSBitmapImageRep(data: tiff),
                   let png = bitmap.representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: path))
                }
                done()
            }
        }
    }

    // put the window on screen, behind every other window and without focus. Enough for a snapshot
    static func show(_ handle: CaskWindow) {
        DispatchQueue.main.async {
            handle.window.orderBack(nil)
        }
    }

    // bring the app and its window to the front and give it focus
    static func activate(_ handle: CaskWindow) {
        DispatchQueue.main.async {
            handle.window.makeKeyAndOrderFront(nil)
            NSApplication.shared.activate(ignoringOtherApps: true)
        }
    }

    // hands the process to AppKit. Returns only when the app quits. Standard output is made unbuffered first, so a
    // line a program prints reaches a pipe before the process is killed rather than dying in the buffer with it
    static func run() {
        setvbuf(stdout, nil, _IONBF, 0)
        app().run()
    }

    static func quit() {
        DispatchQueue.main.async {
            NSApplication.shared.terminate(nil)
        }
    }

    // the app's own files: the Resources directory of a bundle, or the executable's directory when run bare
    static func bundlePath() -> String {
        if let resources = Bundle.main.resourcePath, FileManager.default.fileExists(atPath: resources) {
            return resources
        }
        return Bundle.main.bundleURL.deletingLastPathComponent().path
    }

    // where the app may write: ~/Library/Application Support/<name>, made on first ask
    static func dataPath(_ name: String) -> String {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let directory = base.appendingPathComponent(name, isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.path
    }
}


import Foundation

enum console {
    static func writeLine(_ message: String) { print(message) }
    static func writeError(_ message: String) { FileHandle.standardError.write((message + "\n").data(using: .utf8)!) }
}


import Foundation

enum json {
    static func parse(_ text: String) -> Any {
        guard let data = text.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { return NSNull() }
        return value
    }
    static func stringify(_ value: Any) -> String {
        // a bare number spells the way JSON does everywhere else: the shortest digits that read back to the same
        // value (`6.8`, not the seventeen digits JSONSerialization writes), a whole one without a point
        if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
            let double = number.doubleValue
            if double == double.rounded(), abs(double) < 1e15 { return String(Int(double)) }
            return String(double)
        }
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]) else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }
    static func getField(_ value: Any, _ key: String) -> Any { return (value as? [String: Any])?[key] ?? NSNull() }
    static func getItem(_ value: Any, _ index: Int) -> Any {
        guard let array = value as? [Any], index >= 0, index < array.count else { return NSNull() }
        return array[index]
    }
    static func asNumber(_ value: Any) -> Double { return (value as? NSNumber)?.doubleValue ?? 0 }
    static func asText(_ value: Any) -> String { return value as? String ?? "" }
    static func asBoolean(_ value: Any) -> Bool { return (value as? NSNumber)?.boolValue ?? false }
    static func isNull(_ value: Any) -> Bool { return value is NSNull }
    static func makeObject() -> Any { return [String: Any]() }
    static func setField(_ value: Any, _ key: String, _ field: Any) -> Any {
        var dict = (value as? [String: Any]) ?? [:]
        dict[key] = field
        return dict
    }
    static func makeArray() -> Any { return [Any]() }
    static func pushItem(_ value: Any, _ item: Any) -> Any {
        var items = (value as? [Any]) ?? []
        items.append(item)
        return items
    }
    static func fromText(_ value: String) -> Any { return value }
    static func fromNumber(_ value: Double) -> Any { return value }
    static func fromBoolean(_ value: Bool) -> Any { return value }
    static func makeNull() -> Any { return NSNull() }
    // the shape questions: what a parsed value is, so a reader can walk it without guessing
    static func isArray(_ value: Any) -> Bool { return value is [Any] }
    static func isObject(_ value: Any) -> Bool { return value is [String: Any] }
    static func isText(_ value: Any) -> Bool { return value is String }
    static func isBoolean(_ value: Any) -> Bool {
        guard let number = value as? NSNumber else { return false }
        return CFGetTypeID(number) == CFBooleanGetTypeID()
    }
    static func arraySize(_ value: Any) -> Int { return (value as? [Any])?.count ?? 0 }
    static func arrayItem(_ value: Any, _ index: Int) -> Any { return getItem(value, index) }
    static func objectKeys(_ value: Any) -> [String] { return (value as? [String: Any]).map { Array($0.keys) } ?? [] }
}

import Foundation

func loadBundle(_ slf: CaskWindow, _ path: String) -> Void {
  _ = cask.loadBundle(slf, path)
}

func loadUrl(_ slf: CaskWindow, _ url: String) -> Void {
  _ = cask.loadUrl(slf, url)
}

func onMessage(_ slf: CaskWindow, _ handler: @escaping (String) async -> String) -> Void {
  _ = cask.onMessage(slf, handler)
}

func activate(_ slf: CaskWindow) -> Void {
  _ = cask.activate(slf)
}

func run() -> Void {
  _ = cask.run()
}

func quit() -> Void {
  _ = cask.quit()
}

func exit(_ status: Int) -> Void {
  _ = cask.exit(status)
}

func writeLine(_ message: String) -> Void {
  _ = console.writeLine(message)
}

func log(_ message: String) -> Void {
  writeLine(message)
}

func isAllowed(_ command: String) -> Bool {
  if (command == "cask_bundle_path") {
    return true
  } else if (command == "cask_data_path") {
    return true
  } else if (command == "cask_exit") {
    return true
  } else if (command == "cask_quit") {
    return true
  } else if (command == "cask_log") {
    return true
  } else {
    return false
  }
  fatalError("unreachable")
}

func runCommand(_ command: String, _ arguments: Any) async -> Any {
  var line = json.asText(json.getField(arguments, "text"))
  if (command == "cask_bundle_path") {
    return json.fromText(cask.bundlePath())
  } else if (command == "cask_data_path") {
    return json.fromText(cask.dataPath(json.asText(json.getField(arguments, "name"))))
  } else if (command == "cask_exit") {
    exit(Int(json.asNumber(json.getField(arguments, "status"))))
    return json.makeNull()
  } else if (command == "cask_quit") {
    quit()
    return json.makeNull()
  } else {
    log("page: \(line)")
    return json.makeNull()
  }
  fatalError("unreachable")
}

func dispatch(_ message: String) async -> String {
  var request = json.parse(message)
  var id = json.asText(json.getField(request, "id"))
  var command = json.asText(json.getField(request, "command"))
  var reply = json.setField(json.makeObject(), "id", json.fromText(id))
  if isAllowed(command) {
    reply = json.setField(reply, "value", await runCommand(command, json.getField(request, "arguments")))
  } else {
    reply = json.setField(reply, "exception", json.fromText("command-not-allowed"))
  }
  return json.stringify(reply)
}

func boot(_ place: String, _ remote: Bool) -> Void {
  var made = cask.openWindow("Blog", 960, 720)
  onMessage(made, dispatch)
  if remote {
    loadUrl(made, place)
  } else {
    loadBundle(made, place)
  }
  activate(made)
  run()
}

boot("/Users/lancepollard/base/crew/cluesurf/deck/term/deck/term/deck/site/test/site/host/macos/Blog.app/Contents/Resources/webview", false)
