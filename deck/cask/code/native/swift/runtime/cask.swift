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
Object.defineProperty(window, 'term', { value: Object.freeze({
  post: function (text) { window.webkit.messageHandlers.term.postMessage(String(text)) }
}) });
"""

// the name the page posts to and the handler is registered under
private let BRIDGE_NAME = "term"

// receives every `window.term.post`. One per window, holding the handler the Term program registered
final class CaskBridge: NSObject, WKScriptMessageHandler {
    var onMessage: ((String) -> Void)?

    func userContentController(
        _ controller: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let text = message.body as? String else { return }
        onMessage?(text)
    }
}

// keeps the app alive after the last window closes only as long as the program wants; a one-window cask quits
final class CaskDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.activate(ignoringOtherApps: true)
    }
}

// one window and the WebView inside it. The opaque handle Term holds
final class CaskWindow {
    let window: NSWindow
    let webview: WKWebView
    let bridge: CaskBridge

    init(window: NSWindow, webview: WKWebView, bridge: CaskBridge) {
        self.window = window
        self.webview = webview
        self.bridge = bridge
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

        let window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = title
        window.contentView = webview
        window.center()
        window.makeKeyAndOrderFront(nil)
        // the handle owns the window; without this AppKit releases it when the last reference goes
        window.isReleasedWhenClosed = false

        return CaskWindow(window: window, webview: webview, bridge: bridge)
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

    static func onMessage(_ handle: CaskWindow, _ handler: @escaping (String) -> Void) {
        handle.bridge.onMessage = handler
    }

    // hands the process to AppKit. Returns only when the app quits
    static func run() {
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
