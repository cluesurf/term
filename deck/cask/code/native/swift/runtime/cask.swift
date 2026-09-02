// The cask runtime on Apple: one window holding one WKWebView, a script message handler that receives what the page
// posts through `window.term.post(text)`, and `eval` to answer it. Reached only through the public cask API in
// ../cask.tree, whose tasks map to `cask.openWindow`, `cask.loadBundle`, `cask.loadUrl`, `cask.eval`,
// `cask.onMessage`, `cask.onReady`, `cask.snapshot`, `cask.show`, `cask.activate`, `cask.run`, `cask.quit`,
// `cask.exit`, `cask.bundlePath`, `cask.dataPath`.
//
// ONE FILE, TWO TOOLKITS. macOS hosts the WebView in an AppKit window and iOS in a UIKit window, and everything
// between the page and the toolkit is the same: the bridge, the navigation delegate, the snapshot. The toolkit halves
// sit under `#if canImport(AppKit)` and `#if canImport(UIKit)`, so the same emitted program builds for either target
// and the Term module above never learns which.
//
// Two rules the WebView imposes and this file honours. Every call into WKWebView happens on the main thread, so
// `eval` and `snapshot` hop there. The bridge shim is injected at document start so the page finds `window.term`
// before its own script runs, which is what wry does for `window.ipc`
// (land/code/github.com/tauri-apps/wry/src/wkwebview/mod.rs:642).
//
// On iOS a window cannot exist before UIApplicationMain runs, so `openWindow` records what was asked and `run`
// builds it inside the app delegate. A load asked for before `run` is kept on the handle and applied then. On macOS
// the window is made at once and a load runs at once.
import Foundation
import WebKit

#if canImport(AppKit)
import AppKit
#endif
#if canImport(UIKit)
import UIKit
#endif

// what the page sees. `window.term.post` is the one way in; the reply and every pushed event come back through
// `eval` as `window.term.reply(message)`. The post function is frozen so a page script cannot swap it for a spy
private let BRIDGE_SHIM = """
Object.defineProperty(window, 'term', { value: {
  post: function (text) { window.webkit.messageHandlers.term.postMessage(String(text)) },
  reply: function (message) { if (window.term.onReply) { window.term.onReply(message) } },
  push: function (name, text) { if (window.term.onPush) { window.term.onPush(name, text) } },
  onReply: null,
  onPush: null
} });
Object.freeze(window.term.post);
"""

// the name the page posts to and the handler is registered under
private let BRIDGE_NAME = "term"

// receives every `window.term.post`. One per window, holding the handler the Term program registered. The handler
// is asynchronous and answers with the reply text; the reply goes back into the page on the main thread, which is
// the one thread WKWebView accepts a script from. CASK_TRACE=1 in the environment prints every message and reply
final class CaskBridge: NSObject, WKScriptMessageHandler {
    var onMessage: ((String) async -> String)?
    weak var webview: WKWebView?
    private let trace = ProcessInfo.processInfo.environment["CASK_TRACE"] != nil

    func userContentController(
        _ controller: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let text = message.body as? String, let handler = onMessage else { return }
        if trace { print("cask <- \(text)") }
        Task {
            let reply = await handler(text)
            if self.trace { print("cask -> \(reply)") }
            await MainActor.run {
                self.webview?.evaluateJavaScript("window.term.reply(\(reply))", completionHandler: nil)
            }
        }
    }
}

// tells the Term program when the page has finished loading, which is when `eval` and `snapshot` mean something
final class CaskNavigation: NSObject, WKNavigationDelegate {
    var onReady: (() -> Void)?

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        onReady?()
    }
}

// what a page load is, kept until the window exists on the toolkit that builds it late
private enum PendingLoad {
    case bundle(String)
    case url(String)
}

// one window and the WebView inside it. The opaque handle Term holds. The WebView is made at `openWindow` on every
// toolkit, because a WKWebView may exist before it is in a window; the window itself is made when the toolkit allows
final class CaskWindow {
    let title: String
    let width: Int
    let height: Int
    let webview: WKWebView
    let bridge = CaskBridge()
    let navigation = CaskNavigation()
    fileprivate var pending: PendingLoad?
    #if canImport(AppKit)
    var window: NSWindow?
    #endif
    #if canImport(UIKit)
    var window: UIWindow?
    #endif

    init(title: String, width: Int, height: Int) {
        self.title = title
        self.width = width
        self.height = height

        let controller = WKUserContentController()
        controller.add(bridge, name: BRIDGE_NAME)
        controller.addUserScript(
            WKUserScript(source: BRIDGE_SHIM, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        // a bundle is loaded from the app's own files, and a page loaded from a file URL may fetch its siblings
        configuration.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")

        webview = WKWebView(
            frame: CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)),
            configuration: configuration
        )
        webview.navigationDelegate = navigation
        bridge.webview = webview
    }

    // run the load that was asked for, once the window can carry it
    fileprivate func applyPendingLoad() {
        guard let load = pending else { return }
        pending = nil
        switch load {
        case .bundle(let path):
            let directory = URL(fileURLWithPath: path, isDirectory: true)
            webview.loadFileURL(directory.appendingPathComponent("index.html"), allowingReadAccessTo: directory)
        case .url(let text):
            if let url = URL(string: text) {
                webview.load(URLRequest(url: url))
            }
        }
    }
}

#if canImport(AppKit)

// keeps the app alive after the last window closes only as long as the program wants; a one-window cask quits
final class CaskDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

#endif

#if canImport(UIKit)

// the one window of an iOS cask, built when the app has launched. `openWindow` leaves the handle here for it
final class CaskAppDelegate: NSObject, UIApplicationDelegate {
    static var pending: CaskWindow?
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        guard let handle = CaskAppDelegate.pending else { return true }
        let window = UIWindow(frame: UIScreen.main.bounds)
        let controller = UIViewController()
        controller.view = handle.webview
        handle.webview.frame = window.bounds
        handle.webview.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window
        handle.window = window
        handle.applyPendingLoad()
        return true
    }
}

#endif

enum cask {
    #if canImport(AppKit)
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
    #endif

    // Term's `number` is `Int` on this backend, so the size arrives as integers
    static func openWindow(_ title: String, _ width: Int, _ height: Int) -> CaskWindow {
        #if canImport(AppKit)
        // the application object before the WebView: WebKit starts its content process against the running app,
        // and a WKWebView made before NSApplication exists never finishes loading
        _ = app()
        #endif
        let handle = CaskWindow(title: title, width: width, height: height)
        #if canImport(AppKit)
        let frame = NSRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height))
        let window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = title
        handle.webview.autoresizingMask = [.width, .height]
        window.contentView = handle.webview
        window.center()
        // the handle owns the window; without this AppKit releases it when the last reference goes
        window.isReleasedWhenClosed = false
        // NOT on screen yet. A test that only talks over the bridge never shows anything; `show` puts the window
        // on screen behind everything, `activate` brings it to the front with focus
        handle.window = window
        #endif
        #if canImport(UIKit)
        // the window is built by the app delegate once UIApplicationMain runs. The last handle opened is the one shown
        CaskAppDelegate.pending = handle
        #endif
        return handle
    }

    // `path` is the directory holding index.html; the page may read its siblings and nothing above them
    static func loadBundle(_ handle: CaskWindow, _ path: String) {
        handle.pending = .bundle(path)
        #if canImport(AppKit)
        DispatchQueue.main.async { handle.applyPendingLoad() }
        #endif
    }

    static func loadUrl(_ handle: CaskWindow, _ url: String) {
        handle.pending = .url(url)
        #if canImport(AppKit)
        DispatchQueue.main.async { handle.applyPendingLoad() }
        #endif
    }

    // always on the main thread, which is the one rule WKWebView enforces
    static func eval(_ handle: CaskWindow, _ script: String) {
        DispatchQueue.main.async {
            handle.webview.evaluateJavaScript(script, completionHandler: nil)
        }
    }

    // push an event into the page: `listen` on the page side receives it by name. The other direction of the
    // bridge, for what a cask has to say unasked: progress, a file changed, a window event
    static func emit(_ handle: CaskWindow, _ name: String, _ text: String) {
        let encoded = try? JSONSerialization.data(withJSONObject: [name, text], options: [])
        guard let json = encoded.flatMap({ String(data: $0, encoding: .utf8) }) else { return }
        DispatchQueue.main.async {
            handle.webview.evaluateJavaScript("window.term.push.apply(null, \(json))", completionHandler: nil)
        }
    }

    static func onMessage(_ handle: CaskWindow, _ handler: @escaping (String) async -> String) {
        handle.bridge.onMessage = handler
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
                #if canImport(AppKit)
                if let image = image,
                   let tiff = image.tiffRepresentation,
                   let bitmap = NSBitmapImageRep(data: tiff),
                   let png = bitmap.representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: path))
                }
                #endif
                #if canImport(UIKit)
                if let png = image?.pngData() {
                    try? png.write(to: URL(fileURLWithPath: path))
                }
                #endif
                done()
            }
        }
    }

    // put the window on screen, behind every other window and without focus. Enough for a snapshot. On iOS the
    // one window is on screen once the app runs, so this has nothing to add
    static func show(_ handle: CaskWindow) {
        #if canImport(AppKit)
        DispatchQueue.main.async {
            handle.window?.orderBack(nil)
        }
        #endif
    }

    // bring the app and its window to the front and give it focus
    static func activate(_ handle: CaskWindow) {
        #if canImport(AppKit)
        DispatchQueue.main.async {
            handle.window?.makeKeyAndOrderFront(nil)
            NSApplication.shared.activate(ignoringOtherApps: true)
        }
        #endif
    }

    // hands the process to the toolkit. Returns only when the app quits. Standard output is made unbuffered first,
    // so a line a program prints reaches a pipe before the process is killed rather than dying in the buffer with it
    static func run() {
        setvbuf(stdout, nil, _IONBF, 0)
        #if canImport(AppKit)
        app().run()
        #endif
        #if canImport(UIKit)
        _ = UIApplicationMain(
            CommandLine.argc,
            CommandLine.unsafeArgv,
            nil,
            NSStringFromClass(CaskAppDelegate.self)
        )
        #endif
    }

    static func quit() {
        DispatchQueue.main.async {
            #if canImport(AppKit)
            NSApplication.shared.terminate(nil)
            #endif
            #if canImport(UIKit)
            Foundation.exit(0)
            #endif
        }
    }

    // leave with a status the caller of the process can read, said out loud first for a simulator's console, where
    // no caller reads a status. The smoke test's verdict
    static func exit(_ status: Int) {
        print("cask exit \(status)")
        Foundation.exit(Int32(status))
    }

    // the app's own files: the Resources directory of a macOS bundle, the bundle itself on iOS, or the executable's
    // directory when run bare
    static func bundlePath() -> String {
        if let resources = Bundle.main.resourcePath, FileManager.default.fileExists(atPath: resources) {
            return resources
        }
        return Bundle.main.bundleURL.deletingLastPathComponent().path
    }

    // where the app may write: Application Support on macOS, the app's Documents on iOS, made on first ask
    static func dataPath(_ name: String) -> String {
        #if canImport(AppKit)
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let directory = base.appendingPathComponent(name, isDirectory: true)
        #else
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        #endif
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.path
    }
}
