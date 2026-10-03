// The toolkit view host on Apple (native-dom-0005): the dom's node contract over REAL platform views, so a Term program renders
// with no WebView and no JavaScript engine. The render runtime (site/code/view/render.tree) is Solid-style: it creates
// a node, sets a property, appends, removes, and never re-describes the screen. AppKit and UIKit are retained trees of
// exactly that shape, so each call maps to one platform call. See note/term/app/10-native-dom.md.
//
// Reached only through ../dom.tree, whose tasks map to `nativeView.*`. Its Android twin is native-view.kt beside it. ONE FILE, TWO TOOLKITS, the way the cask runtime
// is written: AppKit under `#if canImport(AppKit)`, UIKit under `#if canImport(UIKit)`, and everything between the
// Term program and the toolkit shared.
//
// What a tag becomes:
//
//   a text node            a label (NSTextField label, UILabel)
//   button                 a native button. Its title is the text of its children, which are never installed as views
//   input, textarea        a native text field, its value two-way
//   switch                 the platform's switch (NSSwitch, UISwitch). `aria-checked` is its state, its change is `click`
//   img                    NSImageView, UIImageView. `src` is a `data:` URI, a path or a URL, `alt` its accessibility label
//   hr                     a hairline: NSBox's separator, a 1 point UIView. Vertical in a row
//   scroll                 NSScrollView, UIScrollView, around a vertical stack the children go into
//   span a b i em strong   a horizontal stack (an inline run)
//   anything else          a vertical stack: the container every layout starts from
//
// Every call happens on the main thread, the only one a toolkit may be touched from. An event handler fires there and
// the effects it triggers run inside it, but a page's async `boot` resumes after an await wherever Swift chose, so every
// `nativeView` entry point hops to the main thread first (`onMain`) when it is called from another (native-dom-0014).
import Foundation
import CoreText

#if canImport(AppKit)
import AppKit
typealias TermPlatformView = NSView
typealias TermStack = NSStackView
#endif
#if canImport(UIKit)
import UIKit
typealias TermPlatformView = UIView
typealias TermStack = UIStackView
#endif

// the events a field reports from its own edits: listening for any of them watches the field (native-text-0003)
private let FIELD_EVENTS: Set<String> = ["input", "compositionstart", "compositionupdate", "compositionend"]

// the tags that lay their children out in a row, as inline elements do in a browser
private let INLINE_TAGS: Set<String> = ["span", "a", "b", "i", "em", "strong", "small", "code", "label", "abbr", "kbd"]

// receives a platform event and runs the Term handler. Held by the node, since the toolkit holds its target weakly
final class TermAction: NSObject {
    let run: () -> Void

    init(_ run: @escaping () -> Void) {
        self.run = run
    }

    @objc func fire() {
        run()
    }
}

#if canImport(UIKit)
// a page sheet the person swiped away: reported to the dialog's node as `close`
final class TermSheetWatcher: NSObject, UIAdaptivePresentationControllerDelegate {
    weak var node: TermNode?

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        node?.fire("close")
    }
}
#endif

#if canImport(AppKit)
// THE FIELD EDITOR EVERY HOST WINDOW GIVES ITS FIELDS (native-text-0003): AppKit's own text view, plus a report of each
// input method step. An input method writes marked text with `setMarkedText`, and AppKit tells the field's delegate
// nothing about it: `controlTextDidChange` comes only at the commit. So a Korean syllable or a Japanese reading being
// composed was invisible to the program until it was final. This reports every marked edit the way an edit is
// reported, and the commit still arrives as `controlTextDidChange`, which ends the composition
final class TermFieldEditor: NSTextView {
    private func report() {
        guard let field = delegate as? NSTextField, let node = (field.delegate as? TermFieldDelegate)?.node else { return }
        node.value = string
        nativeView.noteComposition(node, marked: hasMarkedText())
        node.fire("input")
    }

    override func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        super.setMarkedText(string, selectedRange: selectedRange, replacementRange: replacementRange)
        report()
    }

    // the input method gave up its marked text as it stands: committed, so the composition ends
    override func unmarkText() {
        let was = hasMarkedText()
        super.unmarkText()
        if was {
            report()
        }
    }
}

// hands each text field of a window the host's field editor
final class TermWindowDelegate: NSObject, NSWindowDelegate {
    private lazy var editor: TermFieldEditor = {
        let made = TermFieldEditor()
        made.isFieldEditor = true
        return made
    }()

    func windowWillReturnFieldEditor(_ sender: NSWindow, to client: Any?) -> Any? {
        client is NSTextField ? editor : nil
    }
}

// AppKit reports a field's edits through its delegate
final class TermFieldDelegate: NSObject, NSTextFieldDelegate {
    weak var node: TermNode?

    func controlTextDidChange(_ note: Notification) {
        guard let node = node, let field = note.object as? NSTextField else { return }
        node.value = field.stringValue
        nativeView.noteComposition(node, marked: (field.currentEditor() as? NSTextView)?.hasMarkedText() ?? false)
        node.fire("input")
    }
}
#endif

// one node of the tree: the platform view, plus what the dom contract can ask of it that a view does not hold itself
final class TermNode {
    enum Kind {
        case text
        case container
        case button
        case field
        case toggle
        // NSSlider, UISlider: face's slider on these platforms (native-dom-0026)
        case range
        // NSPopUpButton, a UIButton showing a selection menu: face's select on these platforms (native-dom-0026)
        case choice
        // face's dialog: a stack of content the platform presents itself, an NSPanel sheet on macOS and a presented
        // view controller on iOS, never placed in the page it is appended to (native-dom-0026)
        case sheet
        // the vocabulary's image, divider and scroll (native-dom-0049, note/term/view/11-vocabulary.md)
        case image
        case divider
        case scroll
    }

    let key: Int
    let tag: String
    let kind: Kind
    let view: TermPlatformView
    var text: String
    var value = ""
    // whether the field holds text an input method has not committed yet (native-text-0003)
    var composing = false
    var attributes: [(name: String, value: String)] = []
    var styles: [String: String] = [:]
    // the properties set by `set-style` or a `style` attribute, which win over any class's row, as inline CSS does
    var inline = Set<String>()
    // the properties the style table set from this node's classes, so a class removed takes its rows with it
    var fromClass = Set<String>()
    // whether a color or font was ever drawn on this node's text, so one taken away can be drawn back as the default
    var textStyled = false
    var classes: [String] = []
    var children: [TermNode] = []
    weak var parent: TermNode?
    var listeners: [(event: String, run: () -> Void)] = []
    // the action targets and delegates the toolkit holds weakly, kept alive by the node
    var keep: [AnyObject] = []
    var tapInstalled = false
    // a scroll's content: the stack its children go into, inside the scroll view, which is what the parent holds
    let inner: TermStack?
    // a divider's thickness, kept so a divider in a row can turn it into a width (a vertical line)
    var line: NSLayoutConstraint?
    // an image's loaded picture (NSImage, UIImage), kept so a change of fit can draw it again
    var picture: AnyObject?

    // the stack this node's children are installed in: its own view, or a scroll's content
    var box: TermStack? {
        inner ?? view as? TermStack
    }

    init(key: Int, tag: String, text: String) {
        self.key = key
        self.tag = tag
        self.text = text
        var content: TermStack?

        if tag.isEmpty {
            kind = .text
            #if canImport(AppKit)
            view = NSTextField(labelWithString: text)
            #endif
            #if canImport(UIKit)
            let label = UILabel()
            label.text = text
            label.numberOfLines = 0
            view = label
            #endif
        } else if tag == "button" {
            kind = .button
            #if canImport(AppKit)
            let button = NSButton(title: "", target: nil, action: nil)
            button.bezelStyle = .rounded
            view = button
            #endif
            #if canImport(UIKit)
            let button = UIButton(type: .system)
            view = button
            #endif
        } else if tag == "switch" {
            kind = .toggle
            #if canImport(AppKit)
            view = NSSwitch()
            #endif
            #if canImport(UIKit)
            view = UISwitch()
            #endif
        } else if tag == "slider" {
            kind = .range
            #if canImport(AppKit)
            let slider = NSSlider(value: 0, minValue: 0, maxValue: 100, target: nil, action: nil)
            slider.isContinuous = true
            view = slider
            #endif
            #if canImport(UIKit)
            let slider = UISlider()
            slider.minimumValue = 0
            slider.maximumValue = 100
            view = slider
            #endif
        } else if tag == "sheet" {
            kind = .sheet
            let stack = TermStack()
            #if canImport(AppKit)
            stack.orientation = .vertical
            stack.alignment = .leading
            #endif
            #if canImport(UIKit)
            stack.axis = .vertical
            stack.alignment = .leading
            #endif
            stack.spacing = 0
            view = stack
        } else if tag == "choice" {
            kind = .choice
            #if canImport(AppKit)
            view = NSPopUpButton(frame: .zero, pullsDown: false)
            #endif
            #if canImport(UIKit)
            // the menu IS the picker: a tap shows the choices, and the button's title becomes the one chosen
            let button = UIButton(type: .system)
            button.showsMenuAsPrimaryAction = true
            button.changesSelectionAsPrimaryAction = true
            view = button
            #endif
        } else if tag == "input" || tag == "textarea" {
            kind = .field
            #if canImport(AppKit)
            view = NSTextField(string: "")
            #endif
            #if canImport(UIKit)
            let field = UITextField()
            field.borderStyle = .roundedRect
            // an empty UITextField is as wide as its text, which is nothing. A browser draws an empty input about 20
            // characters wide and AppKit 186 points, so this is the floor, below a style's `width`, which still wins
            // (native-dom-0014: the blog's two fields were bare squares)
            let floor = field.widthAnchor.constraint(greaterThanOrEqualToConstant: 186)
            floor.priority = .defaultHigh
            floor.isActive = true
            view = field
            #endif
        } else if tag == "img" {
            // its picture arrives with `src`, and its words with `alt` (native-dom-0049)
            kind = .image
            #if canImport(AppKit)
            let picture = NSImageView()
            picture.imageScaling = .scaleProportionallyUpOrDown
            view = picture
            #endif
            #if canImport(UIKit)
            let picture = UIImageView()
            picture.contentMode = .scaleAspectFit
            picture.clipsToBounds = true
            view = picture
            #endif
        } else if tag == "hr" {
            // a hairline across its stack. One in a row turns into a vertical line when it is appended
            kind = .divider
            #if canImport(AppKit)
            // not NSBox's separator: that is a 5 point frame with a line drawn inside it, so its frame read 5 tall
            let rule = TermLine()
            #endif
            #if canImport(UIKit)
            let rule = UIView()
            rule.backgroundColor = .separator
            #endif
            // a line is a picture of separation, not content: out of the accessibility tree, as the contract has it
            // for the toolkits (note/term/view/11-vocabulary.md, "Accessibility")
            #if canImport(AppKit)
            rule.setAccessibilityElement(false)
            rule.setAccessibilityHidden(true)
            #endif
            #if canImport(UIKit)
            rule.isAccessibilityElement = false
            rule.accessibilityElementsHidden = true
            #endif
            rule.translatesAutoresizingMaskIntoConstraints = false
            let thickness = rule.heightAnchor.constraint(equalToConstant: 1)
            thickness.isActive = true
            line = thickness
            view = rule
        } else if tag == "scroll" {
            // a frame whose content may be taller than it: the platform's scroll view around a vertical stack the
            // children go into, as wide as the frame, so only the height scrolls (native-dom-0049)
            kind = .scroll
            let stack = TermStack()
            stack.spacing = 0
            stack.translatesAutoresizingMaskIntoConstraints = false
            #if canImport(AppKit)
            stack.orientation = .vertical
            stack.alignment = .leading
            let scroll = NSScrollView()
            scroll.hasVerticalScroller = true
            scroll.drawsBackground = false
            // a flipped clip, so the content starts at the top as it does everywhere else
            scroll.contentView = TermTopClip()
            scroll.documentView = stack
            NSLayoutConstraint.activate([
                stack.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
                stack.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
                stack.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            ])
            #endif
            #if canImport(UIKit)
            stack.axis = .vertical
            stack.alignment = .leading
            let scroll = UIScrollView()
            scroll.addSubview(stack)
            NSLayoutConstraint.activate([
                stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
                stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
                stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
                stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
                stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
            ])
            #endif
            content = stack
            view = scroll
        } else {
            kind = .container
            let stack = TermStack()
            #if canImport(AppKit)
            stack.orientation = INLINE_TAGS.contains(tag) ? .horizontal : .vertical
            stack.alignment = INLINE_TAGS.contains(tag) ? .firstBaseline : .leading
            #endif
            #if canImport(UIKit)
            stack.axis = INLINE_TAGS.contains(tag) ? .horizontal : .vertical
            stack.alignment = INLINE_TAGS.contains(tag) ? .firstBaseline : .leading
            #endif
            // CSS's gap is 0 until a `gap` says otherwise; NSStackView's default of 8 made every native row wider than
            // the same row on the web (native-dom-0027)
            stack.spacing = 0
            view = stack
        }

        inner = content
        #if canImport(UIKit)
        // THE CONTRACT'S TRAITS, set by the host (native-accessibility-0007). UIKit gives a standard control its traits
        // from accessibility bundles it loads only while VoiceOver or another assistive technology runs, so in any other
        // process a UIButton reports none. Set here, a reader gets the same answer either way
        switch kind {
        case .text: view.accessibilityTraits = .staticText
        case .button, .toggle, .choice: view.accessibilityTraits = .button
        case .range: view.accessibilityTraits = .adjustable
        case .image: view.accessibilityTraits = .image
        default: break
        }
        #endif
    }

    // a text node takes its parent's meaning as traits: under `h1` to `h6` it is a header, under `a` a link, which is
    // where UIKit puts both (native-accessibility-0007). AppKit and Android read the parent's role from the tree
    func adoptTraits() {
        #if canImport(UIKit)
        guard kind == .text, let parent else { return }
        var traits: UIAccessibilityTraits = .staticText
        if parent.tag.count == 2, parent.tag.hasPrefix("h"), let level = Int(parent.tag.dropFirst()), (1...6).contains(level) {
            traits.insert(.header)
        }
        if parent.tag == "a" {
            traits.insert(.link)
        }
        view.accessibilityTraits = traits
        #endif
    }

    // the text under this node, in order: what a button shows as its title
    var textContent: String {
        kind == .text ? text : children.map { $0.textContent }.joined()
    }

    // the nearest node, this one or above, whose children are drawn by the node itself rather than installed
    var drawingAncestor: TermNode? {
        var at: TermNode? = self
        while let node = at {
            if node.kind == .button {
                return node
            }
            at = node.parent
        }
        return nil
    }

    func fire(_ event: String) {
        for listener in listeners where listener.event == event {
            listener.run()
        }
    }

    // a button draws its children's text as its title
    func refreshTitle() {
        guard kind == .button else { return }
        #if canImport(AppKit)
        (view as? NSButton)?.title = textContent
        #endif
        #if canImport(UIKit)
        // a system button animates a title change, so the drawn label kept the old count while `title(for:)` already
        // read the new one: the screenshot of 2026-10-02 showed `0` beside `high`. Set it unanimated and lay it out now
        if let button = view as? UIButton {
            let title = textContent
            UIView.performWithoutAnimation {
                button.setTitle(title, for: .normal)
                button.layoutIfNeeded()
            }
        }
        #endif
    }
}

#if canImport(AppKit)
// a scroll's clip view, flipped so its content is laid from the top down as a page is
final class TermTopClip: NSClipView {
    override var isFlipped: Bool { true }
}

// a divider: a view filled with the system's separator color, redrawn when the appearance turns light or dark
final class TermLine: NSView {
    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        layer?.backgroundColor = NSColor.separatorColor.cgColor
    }
}

final class TermAppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}
#endif

#if canImport(UIKit)
// iOS builds a window only once UIApplicationMain runs, so the root is made early and installed here
final class TermViewAppDelegate: NSObject, UIApplicationDelegate {
    static var pendingRoot: TermNode?
    static var pendingTitle = ""
    static var afterLaunch: [() -> Void] = []
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        let controller = UIViewController()
        controller.view.backgroundColor = .systemBackground
        controller.title = TermViewAppDelegate.pendingTitle
        if let root = TermViewAppDelegate.pendingRoot {
            let view = root.view
            view.translatesAutoresizingMaskIntoConstraints = false
            controller.view.addSubview(view)
            let guide = controller.view.safeAreaLayoutGuide
            NSLayoutConstraint.activate([
                view.topAnchor.constraint(equalTo: guide.topAnchor, constant: 24),
                view.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 24),
                view.trailingAnchor.constraint(lessThanOrEqualTo: guide.trailingAnchor, constant: -24),
            ])
        }
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window
        nativeView.window = window
        // what was waiting for the window to exist: a trait watch installed before launch (native-dom-0048)
        for body in nativeView.onWindow {
            body()
        }
        nativeView.onWindow = []
        for body in TermViewAppDelegate.afterLaunch {
            DispatchQueue.main.async(execute: body)
        }
        return true
    }
}
#endif

enum nativeView {
    private static var nextKey = 0

    #if canImport(AppKit)
    private static let delegate = TermAppDelegate()
    // every host window's delegate: it gives the window's fields the host's field editor (native-text-0003)
    private static let windowDelegate = TermWindowDelegate()
    static var window: NSWindow?
    #endif
    #if canImport(UIKit)
    static var window: UIWindow?
    // run once, when the window exists: a watch asked for before launch attaches here
    static var onWindow: [() -> Void] = []
    #endif

    // every entry point runs on the main thread, the only one a toolkit may be touched from. A page's async `boot`
    // resumes after an await on whatever thread Swift chose, so its calls can arrive here off the main one
    // (native-dom-0014). The main thread is never blocked waiting on another, so the hop cannot deadlock
    private static func onMain<T>(_ body: () -> T) -> T {
        Thread.isMainThread ? body() : DispatchQueue.main.sync(execute: body)
    }

    // the handle Term holds is `Any`, so every entry point takes `Any` and reads the node out of it
    private static func node(_ handle: Any) -> TermNode {
        guard let node = handle as? TermNode else {
            fatalError("nativeView: not a node: \(handle)")
        }
        return node
    }

    private static func make(_ tag: String, _ text: String) -> TermNode {
        nextKey += 1
        return TermNode(key: nextKey, tag: tag, text: text)
    }

    static func createElement(_ tag: String) -> Any {
        onMain {
            make(tag, "")
        }
    }

    static func createText(_ value: String) -> Any {
        onMain {
            make("", value)
        }
    }

    static func setText(_ handle: Any, _ value: String) {
        onMain {
            let node = node(handle)
            node.text = value
            #if canImport(AppKit)
            (node.view as? NSTextField)?.stringValue = value
            #endif
            #if canImport(UIKit)
            (node.view as? UILabel)?.text = value
            #endif
            node.drawingAncestor?.refreshTitle()
        }
    }

    static func setAttribute(_ handle: Any, _ name: String, _ value: String) {
        onMain {
            let node = node(handle)
            node.attributes.removeAll { $0.name == name }
            node.attributes.append((name: name, value: value))
            // the attributes a platform view has a place for
            switch name {
            case "style":
                applyStyleAttribute(node, value)
            case "placeholder":
                #if canImport(AppKit)
                (node.view as? NSTextField)?.placeholderString = value
                #endif
                #if canImport(UIKit)
                (node.view as? UITextField)?.placeholder = value
                #endif
            case "aria-label":
                // on a control's cell too: the cell is the element VoiceOver speaks (an NSPopUpButton's label set on the
                // view alone was never read, native-accessibility-0007)
                #if canImport(AppKit)
                node.view.setAccessibilityLabel(value)
                (node.view as? NSControl)?.cell?.setAccessibilityLabel(value)
                #endif
                #if canImport(UIKit)
                node.view.accessibilityLabel = value
                #endif
            // out of the accessibility tree, with everything under it (native-accessibility-0007)
            case "aria-hidden":
                let hidden = value == "true"
                #if canImport(AppKit)
                node.view.setAccessibilityElement(!hidden)
                node.view.setAccessibilityHidden(hidden)
                #endif
                #if canImport(UIKit)
                node.view.accessibilityElementsHidden = hidden
                #endif
            case "aria-checked" where node.kind == .toggle:
                #if canImport(AppKit)
                (node.view as? NSSwitch)?.state = value == "true" ? .on : .off
                #endif
                #if canImport(UIKit)
                (node.view as? UISwitch)?.setOn(value == "true", animated: false)
                #endif
            case "min" where node.kind == .range, "max" where node.kind == .range:
                if let number = Double(value) {
                    #if canImport(AppKit)
                    if let slider = node.view as? NSSlider {
                        if name == "min" { slider.minValue = number } else { slider.maxValue = number }
                    }
                    #endif
                    #if canImport(UIKit)
                    if let slider = node.view as? UISlider {
                        if name == "min" { slider.minimumValue = Float(number) } else { slider.maximumValue = Float(number) }
                    }
                    #endif
                }
            case "value" where node.kind == .range:
                setValue(node, value)
            case "open" where node.kind == .sheet:
                value == "true" ? present(node) : dismissSheet(node)
            case "title" where node.kind == .sheet:
                #if canImport(AppKit)
                (node.keep.first { $0 is NSPanel } as? NSPanel)?.title = value
                #endif
                #if canImport(UIKit)
                (node.keep.first { $0 is UIViewController } as? UIViewController)?.title = value
                #endif
            case "options" where node.kind == .choice:
                setChoices(node, value.split(separator: "\n").map(String.init))
            case "src" where node.kind == .image:
                load(picture: node, from: value)
            case "alt" where node.kind == .image:
                // what the picture shows, for a reader that cannot see it: the platform's accessibility label, on the
                // cell too, which is the element VoiceOver speaks for a control
                #if canImport(AppKit)
                node.view.setAccessibilityLabel(value)
                (node.view as? NSControl)?.cell?.setAccessibilityLabel(value)
                #endif
                #if canImport(UIKit)
                node.view.isAccessibilityElement = true
                node.view.accessibilityLabel = value
                #endif
            case "disabled":
                #if canImport(AppKit)
                (node.view as? NSControl)?.isEnabled = value == "false"
                #endif
                #if canImport(UIKit)
                (node.view as? UIControl)?.isEnabled = value == "false"
                #endif
            default:
                break
            }

            // a state attribute a style row is keyed on (`data-state`, `disabled`): the node's rows are chosen again
            if styleRules.contains(where: { $0.attribute == name }) {
                restyle(node)
            }
        }
    }

    // ---- the image (native-dom-0049): a `data:` URI, a file path, or an http(s) URL fetched off the main thread ----

    // the bytes of a `data:` URI (base64 or plain) or a file, or nil for a URL that must be fetched
    private static func bytes(of source: String) -> Data? {
        if source.hasPrefix("data:"), let comma = source.firstIndex(of: ",") {
            let meta = source[..<comma]
            let body = String(source[source.index(after: comma)...])
            return meta.hasSuffix(";base64") ? Data(base64Encoded: body) : body.removingPercentEncoding?.data(using: .utf8)
        }
        if source.hasPrefix("http://") || source.hasPrefix("https://") {
            return nil
        }
        let path = source.hasPrefix("file://") ? (URL(string: source)?.path ?? source) : source
        return FileManager.default.contents(atPath: path)
    }

    private static func load(picture node: TermNode, from source: String) {
        if let data = bytes(of: source) {
            set(picture: node, data)
        } else if let url = URL(string: source) {
            URLSession.shared.dataTask(with: url) { data, _, _ in
                guard let data else { return }
                DispatchQueue.main.async { set(picture: node, data) }
            }.resume()
        }
    }

    private static func set(picture node: TermNode, _ data: Data) {
        #if canImport(AppKit)
        node.picture = NSImage(data: data)
        #endif
        #if canImport(UIKit)
        node.picture = UIImage(data: data)
        #endif
        draw(picture: node)
    }

    // the picture into the view, by its fit: `contain` (the default) inside the frame, `cover` filling it and clipped
    private static func draw(picture node: TermNode) {
        let cover = node.styles["object-fit"]?.trimmingCharacters(in: .whitespaces) == "cover"
        #if canImport(AppKit)
        guard let view = node.view as? NSImageView else { return }
        let image = node.picture as? NSImage
        // NSImageView has no aspect fill: a cover is the layer's contents, drawn with aspect-fill gravity
        view.wantsLayer = true
        view.layer?.masksToBounds = true
        view.image = cover ? nil : image
        view.layer?.contentsGravity = .resizeAspectFill
        view.layer?.contents = cover ? image : nil
        #endif
        #if canImport(UIKit)
        guard let view = node.view as? UIImageView else { return }
        view.contentMode = cover ? .scaleAspectFill : .scaleAspectFit
        view.image = node.picture as? UIImage
        #endif
    }

    // the loaded picture's size in pixels, `none` before one has loaded
    private static func pixels(_ node: TermNode) -> String {
        #if canImport(AppKit)
        let cg = (node.picture as? NSImage)?.cgImage(forProposedRect: nil, context: nil, hints: nil)
        #endif
        #if canImport(UIKit)
        let cg = (node.picture as? UIImage)?.cgImage
        #endif
        return cg.map { "\($0.width)x\($0.height)" } ?? "none"
    }

    private static func label(_ node: TermNode) -> String {
        #if canImport(AppKit)
        return node.view.accessibilityLabel() ?? ""
        #else
        return node.view.accessibilityLabel ?? ""
        #endif
    }

    static func getAttribute(_ handle: Any, _ name: String) -> String {
        onMain {
            node(handle).attributes.first { $0.name == name }?.value ?? ""
        }
    }

    // ---- layout (native-dom-0007): the layout model mapped onto the platform's own stack, no solver of ours ----
    //
    //   flex-direction  row | column            the stack's axis
    //   gap             <n>px                   its spacing
    //   align-items     start | center | end | stretch    its alignment across the axis
    //   justify-content start | space-between   its distribution along the axis
    //   padding         <n>px                   its insets
    //   width, height   <n>px                   a fixed size
    //   flex-grow       <n>                     this child gives up its hugging along its parent's axis
    //
    // `display: flex` is how the web says "a stack", which every container here already is, so it is accepted and
    // means nothing more. Anything else is recorded in `unsupported` and reported, never dropped in silence.

    // every style a host could not honor, as `property: value`, for the check that reports them
    static var unsupported = Set<String>()

    private static func points(_ value: String) -> CGFloat? {
        Double(value.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "px", with: "")).map { CGFloat($0) }
    }

    // CSS's one to four sides, expanded to top, right, bottom, left
    private static func sides(_ value: String) -> [CGFloat]? {
        let parts = value.split(separator: " ").map { points(String($0)) }
        guard (1...4).contains(parts.count), parts.allSatisfy({ $0 != nil }) else { return nil }
        let given = parts.map { $0! }
        let top = given[0]
        let right = given.count > 1 ? given[1] : top
        let bottom = given.count > 2 ? given[2] : top
        let left = given.count > 3 ? given[3] : right
        return [top, right, bottom, left]
    }

    static func setStyle(_ handle: Any, _ property: String, _ value: String) {
        onMain {
            let node = node(handle)
            node.inline.insert(property)
            applyStyle(node, property, value)
        }
    }

    // one declaration onto the platform, from `set-style` or from a style-table row
    private static func applyStyle(_ node: TermNode, _ property: String, _ value: String) {
        node.styles[property] = value
        let value = value.trimmingCharacters(in: .whitespaces)
        // a scroll's layout words (direction, gap, padding) lay out its content
        let stack = node.box

        if drawLook(node, property, value) {
            return
        }

        switch (property, stack) {
        case ("display", _) where value == "flex" || value == "block":
            // `display: flex` is a ROW in CSS until a `flex-direction` says otherwise (native-dom-0037)
            if value == "flex", let stack, node.styles["flex-direction"] == nil {
                #if canImport(AppKit)
                stack.orientation = .horizontal
                #endif
                #if canImport(UIKit)
                stack.axis = .horizontal
                #endif
            }
            return
        case ("flex-direction", let stack?):
            #if canImport(AppKit)
            stack.orientation = value.hasPrefix("row") ? .horizontal : .vertical
            #endif
            #if canImport(UIKit)
            stack.axis = value.hasPrefix("row") ? .horizontal : .vertical
            #endif
        case ("gap", let stack?):
            if let gap = points(value) { stack.spacing = gap; return }
        case ("align-items", let stack?):
            #if canImport(AppKit)
            let row = stack.orientation == .horizontal
            switch value {
            case "start", "flex-start": stack.alignment = row ? .top : .leading
            case "center": stack.alignment = row ? .centerY : .centerX
            case "end", "flex-end": stack.alignment = row ? .bottom : .trailing
            case "stretch":
                // NSStackView has no stretching alignment (`.width` / `.height` left every child at its own size,
                // off to one side): each child that should fill is pinned to the stack's cross axis, here and as
                // children arrive
                stack.alignment = row ? .top : .leading
            default: unsupported.insert("\(property): \(value)")
            }
            #endif
            #if canImport(UIKit)
            switch value {
            case "start", "flex-start": stack.alignment = .leading
            case "center": stack.alignment = .center
            case "end", "flex-end": stack.alignment = .trailing
            // not `.fill`: it would override a child's own width, which CSS keeps. Pinned per child, as on AppKit
            case "stretch": stack.alignment = .leading
            default: unsupported.insert("\(property): \(value)")
            }
            #endif
            if value == "stretch" {
                for child in node.children where shouldFill(child, in: node) {
                    fill(child.view, in: stack)
                }
            }
            return
        case ("justify-content", let stack?):
            switch value {
            case "start", "flex-start":
                #if canImport(AppKit)
                stack.distribution = .gravityAreas
                #endif
                #if canImport(UIKit)
                stack.distribution = .fill
                #endif
            case "space-between":
                stack.distribution = .equalSpacing
            default:
                unsupported.insert("\(property): \(value)")
            }
            return
        case ("padding", let stack?):
            if let inset = sides(value) {
                #if canImport(AppKit)
                stack.edgeInsets = NSEdgeInsets(top: inset[0], left: inset[3], bottom: inset[2], right: inset[1])
                #endif
                #if canImport(UIKit)
                stack.isLayoutMarginsRelativeArrangement = true
                stack.directionalLayoutMargins = NSDirectionalEdgeInsets(top: inset[0], leading: inset[3], bottom: inset[2], trailing: inset[1])
                #endif
                return
            }
        case ("width", _), ("height", _):
            if let size = points(value) {
                node.view.translatesAutoresizingMaskIntoConstraints = false
                let anchor = property == "width" ? node.view.widthAnchor : node.view.heightAnchor
                anchor.constraint(equalToConstant: size).isActive = true
                return
            }
        case ("min-width", _), ("max-width", _), ("min-height", _), ("max-height", _):
            // the vocabulary's frame bounds (native-dom-0049): required, so a control's own size gives way to them
            if let size = points(value) {
                node.view.translatesAutoresizingMaskIntoConstraints = false
                let anchor = property.hasSuffix("width") ? node.view.widthAnchor : node.view.heightAnchor
                let bound = property.hasPrefix("min")
                    ? anchor.constraint(greaterThanOrEqualToConstant: size)
                    : anchor.constraint(lessThanOrEqualToConstant: size)
                bound.isActive = true
                return
            }
        // a scroll IS the platform's scroll view: the overflow the web needs to say is what this view already does
        case ("overflow", _) where node.kind == .scroll, ("overflow-y", _) where node.kind == .scroll:
            return
        case ("object-fit", _) where node.kind == .image && (value == "contain" || value == "cover"):
            // drawn again with the fit now in `styles`, which is where `draw(picture:)` reads it
            draw(picture: node)
            return
        case ("flex-grow", _):
            if let grow = Double(value), grow > 0 {
                #if canImport(AppKit)
                node.view.setContentHuggingPriority(.defaultLow - 1, for: .horizontal)
                node.view.setContentHuggingPriority(.defaultLow - 1, for: .vertical)
                // a stack view holds its own size by a hugging priority of its own, which the content one above does not
                // reach: an empty growing `div` (the vocabulary's spacer) stayed 0 wide (native-dom-0049)
                (node.view as? NSStackView)?.setHuggingPriority(.defaultLow - 1, for: .horizontal)
                (node.view as? NSStackView)?.setHuggingPriority(.defaultLow - 1, for: .vertical)
                #endif
                #if canImport(UIKit)
                node.view.setContentHuggingPriority(.defaultLow - 1, for: .horizontal)
                node.view.setContentHuggingPriority(.defaultLow - 1, for: .vertical)
                #endif
                return
            }
        default:
            break
        }

        if ["flex-direction", "gap", "padding"].contains(property) && stack == nil {
            unsupported.insert("\(property) on \(node.tag.isEmpty ? "text" : node.tag)")
        } else if !["flex-direction"].contains(property) {
            unsupported.insert("\(property): \(value)")
        }
    }

    // a `style` attribute is declarations, each one applied as `set-style` would apply it
    static func applyStyleAttribute(_ node: TermNode, _ text: String) {
        onMain {
            for declaration in text.split(separator: ";") {
                let parts = declaration.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
                if parts.count == 2, !parts[0].isEmpty {
                    setStyle(node, parts[0], parts[1])
                }
            }
        }
    }

    // every style no host could honor, sorted, one per line. Empty when everything mapped
    static func unsupportedStyles() -> String {
        onMain {
            unsupported.sorted().joined(separator: "\n")
        }
    }

    // ---- the look (native-dom-0008): what a style-table row draws beyond layout ----
    //
    //   background, background-color   #rrggbb[aa]               the view's own fill
    //   border                         <n>px solid #rrggbb[aa]   its layer's edge
    //   border-width, border-color     <n>px | #rrggbb[aa]
    //   border-radius                  <n>px                     its layer's corners
    //   opacity                        <n>                       the view's alpha
    //   color, font-size, font-weight  #hex | <n>px | 100..900   INHERITED, as in CSS: drawn on every text under the node
    //   font-family                    a family, or a CSS list   INHERITED; its first family, drawn when available
    //
    // Values arrive resolved: the build turned every token, rem and short hex into these forms (look-table.ts).

    #if canImport(AppKit)
    typealias Paint = NSColor
    typealias Typeface = NSFont
    typealias Weight = NSFont.Weight
    #endif
    #if canImport(UIKit)
    typealias Paint = UIColor
    typealias Typeface = UIFont
    typealias Weight = UIFont.Weight
    #endif

    private static func paint(_ value: String) -> Paint? {
        let digits = value.trimmingCharacters(in: .whitespaces).lowercased()
        guard digits.hasPrefix("#"), digits.count == 7 || digits.count == 9, let number = UInt64(digits.dropFirst(), radix: 16) else {
            return nil
        }
        let rgba = digits.count == 7 ? (number << 8) | 0xff : number
        let channel = { (shift: UInt64) in CGFloat((rgba >> shift) & 0xff) / 255 }
        #if canImport(AppKit)
        return NSColor(srgbRed: channel(24), green: channel(16), blue: channel(8), alpha: channel(0))
        #else
        return UIColor(red: channel(24), green: channel(16), blue: channel(8), alpha: channel(0))
        #endif
    }

    // a color as the table writes it, `#rrggbb`, with the alpha only when it is not opaque
    private static func hex(_ paint: Paint?) -> String {
        guard let paint else { return "" }
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        #if canImport(AppKit)
        guard let srgb = paint.usingColorSpace(.sRGB) else { return "" }
        srgb.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        #else
        paint.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        #endif
        let byte = { (part: CGFloat) in String(format: "%02x", Int((part * 255).rounded())) }
        return "#" + byte(red) + byte(green) + byte(blue) + (alpha < 1 ? byte(alpha) : "")
    }

    // CSS's weights to the platform's, by the nearest step
    private static let WEIGHTS: [(css: Double, weight: Weight)] = [
        (100, .ultraLight), (200, .thin), (300, .light), (400, .regular), (500, .medium),
        (600, .semibold), (700, .bold), (800, .heavy), (900, .black),
    ]

    private static func weight(_ css: Double) -> Weight {
        WEIGHTS.min { abs($0.css - css) < abs($1.css - css) }!.weight
    }

    private static func cssWeight(_ typeface: Typeface?) -> String {
        guard let typeface else { return "" }
        #if canImport(AppKit)
        let traits = typeface.fontDescriptor.object(forKey: .traits) as? [NSFontDescriptor.TraitKey: Any]
        #else
        let traits = typeface.fontDescriptor.object(forKey: .traits) as? [UIFontDescriptor.TraitKey: Any]
        #endif
        let raw = (traits?[.weight] as? CGFloat) ?? 0
        let nearest = WEIGHTS.min { abs($0.weight.rawValue - raw) < abs($1.weight.rawValue - raw) }!
        return String(Int(nearest.css))
    }

    // the layer as it stands, made or not: optional on AppKit, always there on UIKit
    private static func drawnLayer(_ node: TermNode) -> CALayer? {
        node.view.layer
    }

    private static func layer(_ node: TermNode) -> CALayer {
        #if canImport(AppKit)
        node.view.wantsLayer = true
        return node.view.layer!
        #else
        return node.view.layer
        #endif
    }

    // a number the way CSS writes it: `1`, `0.5`
    private static func plain(_ number: CGFloat) -> String {
        let rounded = (Double(number) * 100).rounded() / 100
        return rounded == rounded.rounded() ? String(Int(rounded)) : String(rounded)
    }

    // draw one look declaration. False when the property is not a look property or the value does not read, which
    // leaves it to the layout switch and, failing that, to `unsupported`
    private static func drawLook(_ node: TermNode, _ property: String, _ value: String) -> Bool {
        switch property {
        case "background", "background-color":
            guard let fill = paint(value) else { return false }
            #if canImport(AppKit)
            layer(node).backgroundColor = fill.cgColor
            #else
            node.view.backgroundColor = fill
            #endif
        case "border":
            let parts = value.split(separator: " ").map(String.init)
            guard parts.count == 3, parts[1] == "solid", let width = points(parts[0]), let edge = paint(parts[2]) else { return false }
            layer(node).borderWidth = width
            layer(node).borderColor = edge.cgColor
        case "border-width":
            guard let width = points(value) else { return false }
            layer(node).borderWidth = width
        case "border-color":
            guard let edge = paint(value) else { return false }
            layer(node).borderColor = edge.cgColor
        case "border-radius":
            guard let radius = points(value) else { return false }
            layer(node).cornerRadius = radius
        case "opacity":
            guard let alpha = Double(value) else { return false }
            #if canImport(AppKit)
            node.view.alphaValue = CGFloat(alpha)
            #else
            node.view.alpha = CGFloat(alpha)
            #endif
        case "color":
            guard paint(value) != nil else { return false }
            restyleText(node)
        case "font-size":
            guard points(value) != nil else { return false }
            restyleText(node)
        case "font-weight":
            guard Double(value) != nil else { return false }
            restyleText(node)
        case "font-family":
            guard !firstFamily(value).isEmpty else { return false }
            restyleText(node)
        default:
            return false
        }
        return true
    }

    // a look property taken away: the view drawn as it was before any row set it
    private static func eraseLook(_ node: TermNode, _ property: String) {
        switch property {
        case "background", "background-color":
            #if canImport(AppKit)
            node.view.layer?.backgroundColor = nil
            #else
            node.view.backgroundColor = nil
            #endif
        case "border", "border-width":
            drawnLayer(node)?.borderWidth = 0
        case "border-radius":
            drawnLayer(node)?.cornerRadius = 0
        case "opacity":
            #if canImport(AppKit)
            node.view.alphaValue = 1
            #else
            node.view.alpha = 1
            #endif
        case "color", "font-size", "font-weight", "font-family":
            restyleText(node)
        default:
            break
        }
    }

    // ---- fonts (native-text-0002): a face registered from a file, a `data:` URI or a bundled asset, set by `font-family` ----
    //
    // A family is AVAILABLE when the platform can draw it: one registered here, or one the system already has. Text
    // whose `font-family` names a family that is not available draws in the system face, which is what `check-font`
    // answering false says ahead of time. Registration is for this process only (CoreText's `.process` scope).

    // the families registered in this process, so registering one twice is not a failure
    private static var registeredFamilies: Set<String> = []

    // a file CoreText can register: a path as given, a bundled asset from the app's resources, or a `data:` URI
    // written out to a temporary file first, since CoreText registers files
    private static func fontFile(_ source: String) -> URL? {
        if source.hasPrefix("asset:") {
            let name = String(source.dropFirst("asset:".count))
            return Bundle.main.url(forResource: (name as NSString).deletingPathExtension, withExtension: (name as NSString).pathExtension)
        }
        if source.hasPrefix("data:") {
            guard let data = bytes(of: source) else { return nil }
            let file = FileManager.default.temporaryDirectory.appendingPathComponent("term-font-\(UUID().uuidString).font")
            return (try? data.write(to: file)) == nil ? nil : file
        }
        let path = source.hasPrefix("file://") ? (URL(string: source)?.path ?? source) : source
        return FileManager.default.fileExists(atPath: path) ? URL(fileURLWithPath: path) : nil
    }

    // whether the platform can draw this family: registered here or installed
    private static func hasFamily(_ family: String) -> Bool {
        #if canImport(AppKit)
        return NSFontManager.shared.availableMembers(ofFontFamily: family) != nil
        #else
        return UIFont.familyNames.contains(family)
        #endif
    }

    // register the face in `source` under `family`. True when the platform can now draw the family, which is also
    // the answer for a family registered before. False for a file that does not read or holds another family
    static func registerFont(_ family: String, _ source: String) -> Bool {
        onMain {
            if registeredFamilies.contains(family) {
                return true
            }
            guard let file = fontFile(source) else {
                return false
            }
            var failure: Unmanaged<CFError>?
            _ = CTFontManagerRegisterFontsForURL(file as CFURL, .process, &failure)
            // a file already registered by this process fails the call and is still drawn, so ask the platform
            guard hasFamily(family) else {
                return false
            }
            registeredFamilies.insert(family)
            return true
        }
    }

    static func hasFont(_ family: String) -> Bool {
        onMain {
            hasFamily(family)
        }
    }

    // the characters of a text node the platform draws as a box (native-text-0004): laid out by CoreText in the label's
    // own font with the system cascade, as the label draws it, and every character a run draws with glyph 0 or with
    // the LastResort face, which is the box. Each character once, in the order first met; empty when all are drawn
    static func missingGlyphs(_ handle: Any) -> String {
        onMain {
            let node = node(handle)
            #if canImport(AppKit)
            guard let label = node.view as? NSTextField else { return "" }
            let text = label.stringValue
            let font: CTFont = label.font ?? NSFont.systemFont(ofSize: NSFont.systemFontSize)
            #else
            guard let label = node.view as? UILabel else { return "" }
            let text = label.text ?? ""
            let font: CTFont = label.font ?? UIFont.systemFont(ofSize: 17)
            #endif
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [.font: font]))
            let utf16 = Array(text.utf16)
            var missing: [String] = []
            for run in (CTLineGetGlyphRuns(line) as? [CTRun]) ?? [] {
                let count = CTRunGetGlyphCount(run)
                var glyphs = [CGGlyph](repeating: 0, count: count)
                var indices = [CFIndex](repeating: 0, count: count)
                CTRunGetGlyphs(run, CFRange(location: 0, length: 0), &glyphs)
                CTRunGetStringIndices(run, CFRange(location: 0, length: 0), &indices)
                let attributes = CTRunGetAttributes(run) as NSDictionary
                let face = attributes[kCTFontAttributeName as String].map { CTFontCopyPostScriptName($0 as! CTFont) as String } ?? ""
                for (glyph, index) in zip(glyphs, indices) where glyph == 0 || face.hasPrefix("LastResort") {
                    // the whole character at this index: a surrogate pair is one character
                    let at = Int(index)
                    let width = at + 1 < utf16.count && UTF16.isLeadSurrogate(utf16[at]) ? 2 : 1
                    let character = String(utf16CodeUnits: Array(utf16[at..<min(at + width, utf16.count)]), count: min(width, utf16.count - at))
                    if !missing.contains(character) {
                        missing.append(character)
                    }
                }
            }
            return missing.joined()
        }
    }

    // what the platform's accessibility API reports for a node (native-accessibility-0007): `role|name`, the role in the
    // contract's own spelling (note/term/view/11-vocabulary.md, "Accessibility"). AppKit: `accessibilityRole()` without its
    // `AX` (`AXCheckBox` is `checkBox`). UIKit: the traits, by name, joined with `+`, empty for none. A node out of the
    // tree is `hidden`. The name is the accessibility label, else a label's own text
    static func accessibilityOf(_ handle: Any) -> String {
        onMain {
            let node = node(handle)
            #if canImport(AppKit)
            if node.view.isAccessibilityHidden() {
                return "hidden|"
            }
            // A CONTROL'S ELEMENT IS ITS CELL. NSButton, NSTextField, NSSlider and NSImageView are not accessibility
            // elements themselves (the view answers AXUnknown); their cell is, with the role VoiceOver announces. A view
            // with no cell is asked itself, and one that is not an element at all (a stack) has no node of its own: none
            let cell = (node.view as? NSControl)?.cell
            let raw = cell?.accessibilityRole()?.rawValue
                ?? (node.view.isAccessibilityElement() ? node.view.accessibilityRole()?.rawValue : nil)
                ?? ""
            let role = raw.hasPrefix("AX") ? raw.dropFirst(2).prefix(1).lowercased() + raw.dropFirst(3) : raw
            // the label the element carries, else a field's placeholder (which VoiceOver speaks as its name), else a
            // label's text
            let field = node.view as? NSTextField
            let placeholder = field?.isEditable == true ? field?.placeholderString : nil
            let label = (cell?.accessibilityLabel() ?? node.view.accessibilityLabel()).flatMap { $0.isEmpty ? nil : $0 }
            let name = label ?? placeholder ?? field?.stringValue ?? ""
            #else
            if node.view.accessibilityElementsHidden {
                return "hidden|"
            }
            let traits = node.view.accessibilityTraits
            let named: [(UIAccessibilityTraits, String)] = [
                (.button, "button"), (.link, "link"), (.header, "header"), (.staticText, "staticText"),
                (.image, "image"), (.adjustable, "adjustable"),
            ]
            let role = named.filter { traits.contains($0.0) }.map { $0.1 }.joined(separator: "+")
            // the label, else what VoiceOver speaks in its place: a field's placeholder, a button's title, a label's text
            let label = node.view.accessibilityLabel.flatMap { $0.isEmpty ? nil : $0 }
            let name = label ?? (node.view as? UITextField)?.placeholder ?? (node.view as? UIButton)?.currentTitle
                ?? (node.view as? UILabel)?.text ?? ""
            #endif
            return "\(role)|\(name)"
        }
    }

    // the first family a CSS `font-family` list names, unquoted: `"Noto Sans", serif` is `Noto Sans`
    private static func firstFamily(_ value: String) -> String {
        let first = value.split(separator: ",").first.map(String.init) ?? value
        return first.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
    }

    // the face for a family at a size and weight, or the system face when the platform cannot draw the family
    private static func typefaceFor(_ family: String?, _ size: CGFloat, _ heft: Weight) -> Typeface {
        guard let family, hasFamily(family) else {
            return Typeface.systemFont(ofSize: size, weight: heft)
        }
        #if canImport(AppKit)
        let descriptor = NSFontDescriptor(fontAttributes: [.family: family, .traits: [NSFontDescriptor.TraitKey.weight: heft]])
        return NSFont(descriptor: descriptor, size: size) ?? Typeface.systemFont(ofSize: size, weight: heft)
        #else
        let descriptor = UIFontDescriptor(fontAttributes: [.family: family, .traits: [UIFontDescriptor.TraitKey.weight: heft]])
        return UIFont(descriptor: descriptor, size: size)
        #endif
    }

    // a text property's value at a node: its own, else the nearest ancestor's, which is CSS inheritance
    private static func inherited(_ node: TermNode, _ property: String) -> String? {
        var at: TermNode? = node
        while let here = at {
            if let value = here.styles[property] {
                return value
            }
            at = here.parent
        }
        return nil
    }

    // draw the inherited color and font on the text at and under a node
    private static func restyleText(_ node: TermNode) {
        drawText(node)
        for child in node.children {
            restyleText(child)
        }
    }

    private static func drawText(_ node: TermNode) {
        let ink = inherited(node, "color").flatMap { paint($0) }
        let size = inherited(node, "font-size").flatMap { points($0) }
        let heft = inherited(node, "font-weight").flatMap { Double($0) }
        let family = inherited(node, "font-family").map(firstFamily)

        guard ink != nil || size != nil || heft != nil || family != nil || node.textStyled else {
            return
        }

        node.textStyled = ink != nil || size != nil || heft != nil || family != nil
        #if canImport(AppKit)
        let face = typefaceFor(family, size ?? NSFont.systemFontSize, heft.map(weight) ?? .regular)
        if let field = node.view as? NSTextField {
            field.textColor = ink ?? .labelColor
            field.font = face
        } else if let button = node.view as? NSButton {
            button.contentTintColor = ink
            button.font = face
        }
        #else
        let face = typefaceFor(family, size ?? 17, heft.map(weight) ?? .regular)
        if let label = node.view as? UILabel {
            label.textColor = ink ?? .label
            label.font = face
        } else if let field = node.view as? UITextField {
            field.textColor = ink ?? .label
            field.font = face
        } else if let button = node.view as? UIButton {
            button.setTitleColor(ink, for: .normal)
            button.titleLabel?.font = face
        }
        #endif
    }

    // ---- the style table (native-dom-0008): a `look` sheet compiled at build time, one row per declaration ----
    //
    // `use-styles` loads it once, before the first mount: rows joined by `;`, each `<class>|<state>|<property>: <value>`,
    // where state is empty, `attribute` or `attribute=value` (look-table.ts, styleTableText). A class added or removed,
    // or a state attribute changed, re-applies the node's rows. Plain rows go first and state rows after, the order CSS
    // specificity gives `.c` and `.c[data-state=open]`; within each, a later row wins, as a later rule does

    private struct StyleRule {
        let name: String
        let attribute: String
        let expected: String?
        let property: String
        let value: String
    }

    // the rows in force, and the two tables they are chosen from by the device's color scheme (native-dom-0048)
    private static var styleRules: [StyleRule] = []
    private static var lightRules: [StyleRule] = []
    private static var darkRules: [StyleRule] = []
    private static var darkScheme = false
    // every node a class was ever added to, held weakly, so a scheme change can restyle them all
    private static let styled = NSHashTable<TermNode>.weakObjects()

    // the light table and the dark one. An empty dark table means the sheet has no dark scheme: light serves both
    static func useStyles(_ light: String, _ dark: String) {
        onMain {
            lightRules = rulesOf(light)
            darkRules = dark.isEmpty ? lightRules : rulesOf(dark)
            styleRules = darkScheme ? darkRules : lightRules
        }
    }

    // the device's color scheme, `dark` or anything else for light: every styled node takes its rows from that table
    static func useScheme(_ scheme: String) {
        onMain {
            let dark = scheme == "dark"
            guard dark != darkScheme else { return }
            darkScheme = dark
            styleRules = dark ? darkRules : lightRules
            for node in styled.allObjects {
                restyle(node)
            }
        }
    }

    private static func rulesOf(_ table: String) -> [StyleRule] {
        table.split(separator: ";").compactMap { row in
            let fields = row.split(separator: "|", maxSplits: 2, omittingEmptySubsequences: false).map(String.init)
            guard fields.count == 3 else { return nil }
            let declaration = fields[2].split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            guard declaration.count == 2 else { return nil }
            let on = fields[1].split(separator: "=", maxSplits: 1).map(String.init)
            return StyleRule(
                name: fields[0],
                attribute: on.first ?? "",
                expected: on.count == 2 ? on[1] : nil,
                property: declaration[0],
                value: declaration[1]
            )
        }
    }

    private static func selects(_ node: TermNode, _ rule: StyleRule) -> Bool {
        guard node.classes.contains(rule.name) else { return false }
        if rule.attribute.isEmpty { return true }
        guard let have = node.attributes.first(where: { $0.name == rule.attribute })?.value else { return false }
        if let expected = rule.expected { return have == expected }
        return have != "false"
    }

    private static func restyle(_ node: TermNode) {
        guard !styleRules.isEmpty else { return }
        var wanted: [String: String] = [:]
        var order: [String] = []

        for plain in [true, false] {
            for rule in styleRules where rule.attribute.isEmpty == plain && selects(node, rule) && !node.inline.contains(rule.property) {
                if wanted[rule.property] == nil {
                    order.append(rule.property)
                }
                wanted[rule.property] = rule.value
            }
        }

        for property in node.fromClass where wanted[property] == nil {
            node.styles.removeValue(forKey: property)
            eraseLook(node, property)
        }

        node.fromClass = Set(order)

        for property in order where node.styles[property] != wanted[property] {
            applyStyle(node, property, wanted[property]!)
        }
    }

    // for tests: a look property as the PLATFORM holds it, read off the view or its layer, never off the table
    static func styleOf(_ handle: Any, _ property: String) -> String {
        onMain {
            let node = node(handle)
            #if canImport(AppKit)
            let typeface = (node.view as? NSTextField)?.font ?? (node.view as? NSButton)?.font
            let ink = (node.view as? NSTextField)?.textColor
            let fill = node.view.layer?.backgroundColor.flatMap { NSColor(cgColor: $0) }
            let alpha = node.view.alphaValue
            #else
            let typeface = (node.view as? UILabel)?.font ?? (node.view as? UITextField)?.font
            let ink = (node.view as? UILabel)?.textColor ?? (node.view as? UITextField)?.textColor
            let fill = node.view.backgroundColor
            let alpha = node.view.alpha
            #endif
            let edge = drawnLayer(node)?.borderColor.flatMap { Paint(cgColor: $0) }

            switch property {
            // no fill and a clear one are the same to a reader: `none` on every platform
            case "background":
                let drawn = hex(fill)
                return drawn.isEmpty || (drawn.count == 9 && drawn.hasSuffix("00")) ? "none" : drawn
            case "border": return "\(plain(drawnLayer(node)?.borderWidth ?? 0))px \(hex(edge))"
            case "border-radius": return "\(plain(drawnLayer(node)?.cornerRadius ?? 0))px"
            case "opacity": return plain(alpha)
            case "color": return hex(ink)
            case "font-size": return typeface.map { "\(plain($0.pointSize))px" } ?? ""
            case "font-weight": return cssWeight(typeface)
            case "font-family": return typeface?.familyName ?? ""
            default: return ""
            }
        }
    }

    // where a node is drawn, in points from the window's content origin: `x,y,width,height`. What a layout test reads
    static func frameOf(_ handle: Any) -> String {
        onMain {
            let node = node(handle)
            #if canImport(AppKit)
            guard let content = node.view.window?.contentView else { return "0,0,0,0" }
            content.layoutSubtreeIfNeeded()
            var frame = node.view.convert(node.view.bounds, to: content)
            // AppKit's origin is the bottom left; the web's and every other host's is the top left
            if !content.isFlipped {
                frame.origin.y = content.bounds.height - frame.origin.y - frame.height
            }
            #endif
            #if canImport(UIKit)
            guard let root = node.view.window?.rootViewController?.view else { return "0,0,0,0" }
            root.layoutIfNeeded()
            let frame = node.view.convert(node.view.bounds, to: root)
            #endif
            return [frame.origin.x, frame.origin.y, frame.width, frame.height].map { String(Int($0.rounded())) }.joined(separator: ",")
        }
    }

    static func addClass(_ handle: Any, _ name: String) {
        onMain {
            let node = node(handle)
            if !node.classes.contains(name) {
                node.classes.append(name)
                styled.add(node)
                restyle(node)
            }
        }
    }

    static func removeClass(_ handle: Any, _ name: String) {
        onMain {
            let node = node(handle)
            node.classes.removeAll { $0 == name }
            restyle(node)
        }
    }

    static func focus(_ handle: Any) {
        onMain {
            let node = node(handle)
            #if canImport(AppKit)
            node.view.window?.makeFirstResponder(node.view)
            #endif
            #if canImport(UIKit)
            node.view.becomeFirstResponder()
            #endif
        }
    }

    static func blur(_ handle: Any) {
        onMain {
            let node = node(handle)
            #if canImport(AppKit)
            if node.view.window?.firstResponder === node.view {
                node.view.window?.makeFirstResponder(nil)
            }
            #endif
            #if canImport(UIKit)
            node.view.resignFirstResponder()
            #endif
        }
    }

    // a click is the platform's own: a button's action, or a tap on anything else
    static func listen(_ handle: Any, _ event: String, _ handler: @escaping () -> Void) {
        onMain {
            let node = node(handle)
            node.listeners.append((event: event, run: handler))
            guard event == "click" else {
                if FIELD_EVENTS.contains(event), node.kind == .field {
                    installFieldEvents(node)
                }
                // the macOS picker reports a choice through its action, as `change` (iOS's menu items fire it themselves)
                #if canImport(AppKit)
                if event == "change", node.kind == .choice, !node.keep.contains(where: { $0 is TermAction }),
                   let popUp = node.view as? NSPopUpButton {
                    let action = TermAction { [weak node] in node?.fire("change") }
                    node.keep.append(action)
                    popUp.target = action
                    popUp.action = #selector(TermAction.fire)
                }
                #endif
                // the slider reports its own moves as `input`, the event a web range input fires while it is dragged
                if event == "input", node.kind == .range, !node.keep.contains(where: { $0 is TermAction }) {
                    let action = TermAction { [weak node] in node?.fire("input") }
                    node.keep.append(action)
                    #if canImport(AppKit)
                    if let slider = node.view as? NSSlider {
                        slider.target = action
                        slider.action = #selector(TermAction.fire)
                    }
                    #endif
                    #if canImport(UIKit)
                    (node.view as? UISlider)?.addTarget(action, action: #selector(TermAction.fire), for: .valueChanged)
                    #endif
                }
                return
            }
            if node.kind == .toggle {
                if node.keep.contains(where: { $0 is TermAction }) {
                    return
                }
                let action = TermAction { [weak node] in node?.fire("click") }
                node.keep.append(action)
                #if canImport(AppKit)
                if let control = node.view as? NSSwitch {
                    control.target = action
                    control.action = #selector(TermAction.fire)
                }
                #endif
                #if canImport(UIKit)
                (node.view as? UISwitch)?.addTarget(action, action: #selector(TermAction.fire), for: .valueChanged)
                #endif
            } else if node.kind == .button {
                if node.keep.contains(where: { $0 is TermAction }) {
                    return
                }
                let action = TermAction { [weak node] in node?.fire("click") }
                node.keep.append(action)
                #if canImport(AppKit)
                if let button = node.view as? NSButton {
                    button.target = action
                    button.action = #selector(TermAction.fire)
                }
                #endif
                #if canImport(UIKit)
                (node.view as? UIButton)?.addTarget(action, action: #selector(TermAction.fire), for: .touchUpInside)
                #endif
            } else if !node.tapInstalled {
                node.tapInstalled = true
                let action = TermAction { [weak node] in node?.fire("click") }
                node.keep.append(action)
                #if canImport(AppKit)
                node.view.addGestureRecognizer(NSClickGestureRecognizer(target: action, action: #selector(TermAction.fire)))
                #endif
                #if canImport(UIKit)
                node.view.isUserInteractionEnabled = true
                node.view.addGestureRecognizer(UITapGestureRecognizer(target: action, action: #selector(TermAction.fire)))
                #endif
            }
        }
    }

    // ---- composed input (native-text-0003): an input method's uncommitted text, reported as the web reports it ----
    //
    // A keyboard for Korean, Japanese or Chinese holds a syllable or a reading as MARKED text until the person commits
    // it. Every edit the field reports says whether marked text is present, and this turns that into the web's three
    // events, in its order: `compositionstart` when marking begins, `compositionupdate` for each marked edit, and
    // `compositionend` when the marked text is committed or dropped. `input` follows each edit, as in a browser, and the
    // field's value includes the marked text while it is there, as an input element's does.
    static func noteComposition(_ node: TermNode, marked: Bool) {
        if marked {
            if !node.composing {
                node.composing = true
                node.fire("compositionstart")
            }
            node.fire("compositionupdate")
        } else if node.composing {
            node.composing = false
            node.fire("compositionend")
        }
    }

    // the field's marked text, empty when it holds none: what a web handler reads as a composition event's `data`
    static func composingText(_ handle: Any) -> String {
        onMain {
            let node = node(handle)
            #if canImport(AppKit)
            guard let field = node.view as? NSTextField, let editor = field.currentEditor() as? NSTextView, editor.hasMarkedText() else {
                return ""
            }
            return (editor.string as NSString).substring(with: editor.markedRange())
            #else
            guard let field = node.view as? UITextField, let marked = field.markedTextRange else {
                return ""
            }
            return field.text(in: marked) ?? ""
            #endif
        }
    }

    #if canImport(AppKit)
    // the field's editor, made by making the field first responder: where AppKit's input methods write
    private static func editor(_ field: NSTextField) -> NSTextView? {
        if field.currentEditor() == nil {
            field.window?.makeFirstResponder(field)
        }
        return field.currentEditor() as? NSTextView
    }
    #endif

    // for tests: what an input method does while a person composes, through the platform's own entry point for it
    // (NSTextInputClient's and UITextInput's setMarkedText), so the field reports the edit exactly as it would for a
    // real keyboard. `text` replaces whatever is marked
    static func compose(_ handle: Any, _ text: String) {
        onMain {
            let node = node(handle)
            let end = NSRange(location: (text as NSString).length, length: 0)
            #if canImport(AppKit)
            guard let field = node.view as? NSTextField, let editor = editor(field) else { return }
            editor.setMarkedText(text, selectedRange: end, replacementRange: NSRange(location: NSNotFound, length: 0))
            #else
            guard let field = node.view as? UITextField else { return }
            if !field.isFirstResponder {
                field.becomeFirstResponder()
            }
            field.setMarkedText(text, selectedRange: end)
            #endif
        }
    }

    // for tests: the input method commits, inserting `text` in place of the marked text in one step (NSTextInputClient's
    // and UIKeyInput's insertText, as Android's commitText), so the commit is never reported as one more marked stage
    static func commitComposition(_ handle: Any, _ text: String) {
        onMain {
            let node = node(handle)
            #if canImport(AppKit)
            guard let field = node.view as? NSTextField, let editor = editor(field) else { return }
            editor.insertText(text, replacementRange: NSRange(location: NSNotFound, length: 0))
            #else
            guard let field = node.view as? UITextField else { return }
            field.insertText(text)
            #endif
        }
    }

    private static func installFieldEvents(_ node: TermNode) {
        if node.keep.contains(where: { !($0 is TermAction) }) || node.keep.contains(where: { $0 is TermAction && node.kind == .field }) {
            return
        }
        #if canImport(AppKit)
        let delegate = TermFieldDelegate()
        delegate.node = node
        node.keep.append(delegate)
        (node.view as? NSTextField)?.delegate = delegate
        #endif
        #if canImport(UIKit)
        let action = TermAction { [weak node] in
            guard let node = node, let field = node.view as? UITextField else { return }
            node.value = field.text ?? ""
            noteComposition(node, marked: field.markedTextRange != nil)
            node.fire("input")
        }
        node.keep.append(action)
        (node.view as? UITextField)?.addTarget(action, action: #selector(TermAction.fire), for: .editingChanged)
        #endif
    }

    // DOM semantics: a node has one parent, so appending one that already has a parent moves it
    static func append(_ parentHandle: Any, _ childHandle: Any) {
        onMain {
            let parent = node(parentHandle)
            let child = node(childHandle)
            detach(child)
            child.parent = parent
            parent.children.append(child)
            // a heading's or a link's text is announced as one (native-accessibility-0007)
            child.adoptTraits()
            // the color and font the new parent passes down, as CSS inherits them
            restyleText(child)
            if let drawing = parent.drawingAncestor {
                drawing.refreshTitle()
            } else if child.kind == .sheet {
                // a dialog's content is never in the page: the platform presents it when it opens
                return
            } else if let stack = parent.box {
                stack.addArrangedSubview(child.view)
                if child.kind == .divider {
                    orient(child, across: stack)
                }
                if shouldFill(child, in: parent) {
                    fill(child.view, in: stack)
                }
            }
        }
    }

    // a divider is a line across its stack: horizontal in a column, vertical in a row
    private static func orient(_ divider: TermNode, across stack: TermStack) {
        divider.line?.isActive = false
        let thickness = vertical(stack)
            ? divider.view.heightAnchor.constraint(equalToConstant: 1)
            : divider.view.widthAnchor.constraint(equalToConstant: 1)
        thickness.isActive = true
        divider.line = thickness
        divider.view.translatesAutoresizingMaskIntoConstraints = false
        if vertical(stack) {
            divider.view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        } else {
            divider.view.heightAnchor.constraint(equalTo: stack.heightAnchor).isActive = true
        }
    }

    private static func vertical(_ stack: TermStack) -> Bool {
        #if canImport(AppKit)
        return stack.orientation == .vertical
        #else
        return stack.axis == .vertical
        #endif
    }

    // whether a child fills its stack's cross axis, by CSS's rules (native-dom-0027, 0037). A size the child declared
    // on that axis always wins. An explicit `align-items` decides by itself. Otherwise a FLEX container stretches every
    // child (CSS's default `align-items` is `stretch`), and a BLOCK container's block-level children fill its width
    // while its inline ones and its controls keep their own size.
    private static func shouldFill(_ child: TermNode, in parent: TermNode) -> Bool {
        // a divider spans its stack by itself (`orient`)
        guard let stack = parent.box, child.kind != .divider else { return false }
        let down = vertical(stack)

        if child.styles[down ? "width" : "height"] != nil {
            return false
        }

        if let align = parent.styles["align-items"]?.trimmingCharacters(in: .whitespaces) {
            return align == "stretch"
        }

        if parent.styles["display"]?.trimmingCharacters(in: .whitespaces) == "flex" {
            return down
        }

        // a scroll is a block too: it fills the width and scrolls the height
        return down && (child.kind == .container || child.kind == .scroll) && !INLINE_TAGS.contains(child.tag)
    }

    // the child fills the stack's cross axis inside its insets. Neither stack stretches one child and not its sibling,
    // so this is a constraint per child. The insets are read when the child is pinned, and a style attribute is applied
    // before any child is appended, so a `padding` beside the `align-items` is already in them
    private static func fill(_ child: TermPlatformView, in stack: TermStack) {
        #if canImport(AppKit)
        let across = stack.edgeInsets.left + stack.edgeInsets.right
        let along = stack.edgeInsets.top + stack.edgeInsets.bottom
        #else
        let margins = stack.isLayoutMarginsRelativeArrangement ? stack.directionalLayoutMargins : .zero
        let across = margins.leading + margins.trailing
        let along = margins.top + margins.bottom
        #endif
        child.translatesAutoresizingMaskIntoConstraints = false
        if vertical(stack) {
            child.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -across).isActive = true
        } else {
            child.heightAnchor.constraint(equalTo: stack.heightAnchor, constant: -along).isActive = true
        }
    }

    static func remove(_ handle: Any) {
        onMain {
            detach(node(handle))
        }
    }

    private static func detach(_ child: TermNode) {
        guard let parent = child.parent else { return }
        parent.children.removeAll { $0 === child }
        child.parent = nil
        child.view.removeFromSuperview()
        parent.drawingAncestor?.refreshTitle()
    }

    // `new` takes `old`'s place under the same parent, at the same position
    static func replace(_ oldHandle: Any, _ newHandle: Any) {
        onMain {
            let old = node(oldHandle)
            let fresh = node(newHandle)
            detach(fresh)
            guard let parent = old.parent, let index = parent.children.firstIndex(where: { $0 === old }) else { return }
            // the position among the views actually installed, which is the stack's own index
            let installedBefore = parent.children[..<index].filter { $0.view.superview === parent.box }.count
            parent.children[index] = fresh
            fresh.parent = parent
            old.parent = nil
            old.view.removeFromSuperview()
            if let drawing = parent.drawingAncestor {
                drawing.refreshTitle()
            } else if let stack = parent.box {
                stack.insertArrangedSubview(fresh.view, at: installedBefore)
            }
        }
    }

    static func clear(_ handle: Any) {
        onMain {
            let node = node(handle)
            for child in node.children {
                child.parent = nil
                child.view.removeFromSuperview()
            }
            node.children = []
            node.drawingAncestor?.refreshTitle()
        }
    }

    static func childCount(_ handle: Any) -> Int {
        onMain {
            node(handle).children.count
        }
    }

    // ---- the dialog (native-dom-0026): the platform presents the sheet's content itself ----

    private static func sheetTitle(_ node: TermNode) -> String {
        node.attributes.first { $0.name == "title" }?.value ?? ""
    }

    // is the platform showing it: asked of the platform, never of a flag beside it
    private static func presented(_ node: TermNode) -> Bool {
        #if canImport(AppKit)
        guard let panel = node.keep.first(where: { $0 is NSPanel }) as? NSPanel else { return false }
        return panel.sheetParent != nil
        #else
        // on screen, not on its way: `presentingViewController` is set the moment a presentation starts, and UIKit
        // ignores a dismissal made while one is still in progress
        guard let controller = node.keep.first(where: { $0 is UIViewController }) as? UIViewController else { return false }
        return controller.viewIfLoaded?.window != nil && !controller.isBeingPresented && !controller.isBeingDismissed
        #endif
    }

    private static func present(_ node: TermNode) {
        if presented(node) {
            return
        }
        #if canImport(AppKit)
        guard let window else { return }
        let panel = (node.keep.first { $0 is NSPanel } as? NSPanel) ?? {
            let made = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 200), styleMask: [.titled], backing: .buffered, defer: false)
            // a field in a sheet composes as one in the window does
            made.delegate = windowDelegate
            let content = NSView()
            node.view.translatesAutoresizingMaskIntoConstraints = false
            content.addSubview(node.view)
            NSLayoutConstraint.activate([
                node.view.topAnchor.constraint(equalTo: content.topAnchor, constant: 20),
                node.view.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
                node.view.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor, constant: -20),
            ])
            made.contentView = content
            node.keep.append(made)
            return made
        }()
        panel.title = sheetTitle(node)
        window.beginSheet(panel)
        #endif
        #if canImport(UIKit)
        guard let root = window?.rootViewController else { return }
        let controller = (node.keep.first { $0 is UIViewController } as? UIViewController) ?? {
            let made = UIViewController()
            made.view.backgroundColor = .systemBackground
            node.view.translatesAutoresizingMaskIntoConstraints = false
            made.view.addSubview(node.view)
            let guide = made.view.safeAreaLayoutGuide
            NSLayoutConstraint.activate([
                node.view.topAnchor.constraint(equalTo: guide.topAnchor, constant: 24),
                node.view.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 24),
                node.view.trailingAnchor.constraint(lessThanOrEqualTo: guide.trailingAnchor, constant: -24),
            ])
            made.modalPresentationStyle = .pageSheet
            // a swipe down dismisses a page sheet; the delegate reports it as `close`
            let watcher = TermSheetWatcher()
            watcher.node = node
            made.presentationController?.delegate = watcher
            node.keep.append(watcher)
            node.keep.append(made)
            return made
        }()
        controller.title = sheetTitle(node)
        root.present(controller, animated: false)
        #endif
    }

    // run `body` once the platform has had its turn. UIKit finishes even an unanimated presentation or dismissal with
    // work queued on the main queue, which cannot run while the block that asked is still running: a nested run loop
    // waited a full second and saw nothing (2026-10-02). A program that must see the result asks for it here
    static func later(_ body: @escaping () -> Void) {
        onMain {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: body)
        }
    }

    private static func dismissSheet(_ node: TermNode) {
        guard presented(node) else { return }
        #if canImport(AppKit)
        if let panel = node.keep.first(where: { $0 is NSPanel }) as? NSPanel {
            window?.endSheet(panel)
            panel.orderOut(nil)
        }
        #endif
        #if canImport(UIKit)
        (node.keep.first { $0 is UIViewController } as? UIViewController)?.dismiss(animated: false)
        #endif
    }

    // for tests: dismiss the sheet the way a person does (Esc on a macOS sheet, a swipe down on an iOS page sheet), and
    // its report of that as `close`. Neither gesture can be made from code, so the dismissal is made as the platform
    // makes it and the report the platform sends is sent
    static func dismiss(_ handle: Any) {
        onMain {
            let node = node(handle)
            dismissSheet(node)
            node.fire("close")
        }
    }

    // ---- the select (native-dom-0026): the platform's own picker, its items the options, the chosen one its value ----

    private static func setChoices(_ node: TermNode, _ choices: [String]) {
        let held = choiceValue(node)
        #if canImport(AppKit)
        if let popUp = node.view as? NSPopUpButton {
            popUp.removeAllItems()
            popUp.addItems(withTitles: choices)
        }
        #endif
        #if canImport(UIKit)
        if let button = node.view as? UIButton {
            // each item reports the person's choice as `change`, the event a web `<select>` fires
            let actions = choices.map { choice in
                UIAction(title: choice) { [weak node] _ in node?.fire("change") }
            }
            button.menu = UIMenu(children: actions)
        }
        #endif
        if !held.isEmpty {
            setChoice(node, held)
        }
    }

    private static func setChoice(_ node: TermNode, _ value: String) {
        #if canImport(AppKit)
        (node.view as? NSPopUpButton)?.selectItem(withTitle: value)
        #endif
        #if canImport(UIKit)
        if let button = node.view as? UIButton, let menu = button.menu {
            for case let action as UIAction in menu.children {
                action.state = action.title == value ? .on : .off
            }
            // the menu's chosen item is what the button draws, unanimated so a read straight after sees it
            UIView.performWithoutAnimation {
                button.setTitle(value, for: .normal)
                button.layoutIfNeeded()
            }
        }
        #endif
    }

    // the chosen item as the control holds it
    private static func choiceValue(_ node: TermNode) -> String {
        #if canImport(AppKit)
        return (node.view as? NSPopUpButton)?.titleOfSelectedItem ?? ""
        #else
        guard let button = node.view as? UIButton, let menu = button.menu else { return "" }
        for case let action as UIAction in menu.children where action.state == .on {
            return action.title
        }
        return ""
        #endif
    }

    // for tests: choose an item the way a person does, the control first and then its own report of the choice
    static func choose(_ handle: Any, _ value: String) {
        onMain {
            let node = node(handle)
            #if canImport(AppKit)
            if let popUp = node.view as? NSPopUpButton {
                popUp.selectItem(withTitle: value)
                popUp.sendAction(popUp.action, to: popUp.target)
            }
            #endif
            #if canImport(UIKit)
            // a menu item cannot be tapped from code: the selection is made as the menu makes it, and its report sent
            setChoice(node, value)
            node.fire("change")
            #endif
        }
    }

    // a slider's position as the control holds it, snapped to its `step` as a web range input is, and written the way
    // the web writes a number: `40`, never `40.0`
    private static func rangeValue(_ node: TermNode) -> String {
        #if canImport(AppKit)
        let raw = (node.view as? NSSlider)?.doubleValue ?? 0
        #else
        let raw = Double((node.view as? UISlider)?.value ?? 0)
        #endif
        let step = Double(node.attributes.first { $0.name == "step" }?.value ?? "") ?? 0
        let snapped = step > 0 ? (raw / step).rounded() * step : raw
        let tidy = (snapped * 1_000_000).rounded() / 1_000_000
        return tidy == tidy.rounded() ? String(Int(tidy)) : String(tidy)
    }

    static func getValue(_ handle: Any) -> String {
        onMain {
            let node = node(handle)
            if node.kind == .range {
                return rangeValue(node)
            }
            if node.kind == .choice {
                return choiceValue(node)
            }
            #if canImport(AppKit)
            if let field = node.view as? NSTextField, node.kind == .field {
                return field.stringValue
            }
            #endif
            #if canImport(UIKit)
            if let field = node.view as? UITextField {
                return field.text ?? ""
            }
            #endif
            return node.value
        }
    }

    static func setValue(_ handle: Any, _ value: String) {
        onMain {
            let node = node(handle)
            node.value = value
            if node.kind == .choice {
                setChoice(node, value)
                return
            }
            if node.kind == .range, let number = Double(value) {
                #if canImport(AppKit)
                (node.view as? NSSlider)?.doubleValue = number
                #endif
                #if canImport(UIKit)
                (node.view as? UISlider)?.setValue(Float(number), animated: false)
                #endif
                return
            }
            // a field that already holds the text is left alone: rewriting it moves the cursor to the end and throws away
            // an input method's half-composed character, and the face input writes its signal back after every keystroke
            // (native-dom-0026)
            #if canImport(AppKit)
            if let field = node.view as? NSTextField, node.kind == .field, field.stringValue != value {
                field.stringValue = value
            }
            #endif
            #if canImport(UIKit)
            if let field = node.view as? UITextField, field.text != value {
                field.text = value
            }
            #endif
        }
    }

    // for tests: type into a field the way a person does, the field's text first and then its own report of the edit
    static func type(_ handle: Any, _ text: String) {
        onMain {
            let node = node(handle)
            #if canImport(AppKit)
            if let field = node.view as? NSTextField {
                field.stringValue = text
                (field.delegate as? TermFieldDelegate)?.controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: field))
            }
            #endif
            #if canImport(UIKit)
            if let field = node.view as? UITextField {
                field.text = text
                field.sendActions(for: .editingChanged)
            }
            #endif
        }
    }

    // ---- back (native-navigation-0007): the platform's own way back reaches the app's navigation ----
    //
    // macOS: Go > Back, ⌘[, a menu item whose key equivalent AppKit dispatches. iOS: a swipe in from the left edge, a
    // UIScreenEdgePanGestureRecognizer on the root. The handler answers whether the app's navigation took it.

    private static var backAction: TermAction?
    #if canImport(UIKit)
    private static var backSwipe: UIScreenEdgePanGestureRecognizer?
    #endif

    static func onBack(_ handler: @escaping () -> Bool) {
        onMain {
            let action = TermAction { _ = handler() }
            backAction = action
            #if canImport(AppKit)
            let app = NSApplication.shared
            let menu = app.mainMenu ?? NSMenu()
            let go = NSMenuItem(title: "Go", action: nil, keyEquivalent: "")
            let items = NSMenu(title: "Go")
            let back = NSMenuItem(title: "Back", action: #selector(TermAction.fire), keyEquivalent: "[")
            back.keyEquivalentModifierMask = .command
            back.target = action
            items.addItem(back)
            go.submenu = items
            menu.addItem(go)
            app.mainMenu = menu
            #else
            guard let view = root?.view else { return }
            let swipe = UIScreenEdgePanGestureRecognizer(target: action, action: #selector(TermAction.fire))
            swipe.edges = .left
            view.addGestureRecognizer(swipe)
            backSwipe = swipe
            #endif
        }
    }

    // for tests: the person goes back. macOS: a ⌘[ key event through the menu bar's key-equivalent dispatch, AppKit's
    // own route. iOS: the edge swipe's own action, since a test cannot synthesize the touches of a swipe
    static func pressBack() {
        onMain {
            #if canImport(AppKit)
            guard let event = NSEvent.keyEvent(
                with: .keyDown, location: .zero, modifierFlags: .command, timestamp: 0,
                windowNumber: window?.windowNumber ?? 0, context: nil, characters: "[",
                charactersIgnoringModifiers: "[", isARepeat: false, keyCode: 33
            ) else { return }
            _ = NSApplication.shared.mainMenu?.performKeyEquivalent(with: event)
            #else
            if backSwipe != nil {
                backAction?.fire()
            }
            #endif
        }
    }

    static func measureWidth(_ handle: Any) -> Int {
        onMain {
            Int(node(handle).view.frame.width)
        }
    }

    // ---- the app around the tree ----

    // a window whose content is a new root container, returned as the node to mount into. On iOS the window is
    // built when the app launches; the root is ready at once either way
    // the window's root once `open-root` made it: what `page-body` answers in a native app, as a page's body is its
    // document's (native-dom-0014: a page written for the web mounts on it unchanged)
    static var root: TermNode?

    static func pageBody() -> Any {
        onMain {
            root ?? make("main", "")
        }
    }

    // run an ASYNC body once the app is running and its window exists: a page's `boot` awaits its data before it mounts
    static func launch(_ body: @escaping () async -> Void) {
        onMain {
            afterLaunch {
                Task { @MainActor in await body() }
            }
        }
    }

    static func openRoot(_ title: String, _ width: Int, _ height: Int) -> Any {
        onMain {
            let root = make("main", "")
            nativeView.root = root
            #if canImport(AppKit)
            let app = NSApplication.shared
            if app.delegate == nil {
                // a test window (TERM_WINDOW_AWAY) is an accessory: no Dock icon, and it never becomes the active app
                app.setActivationPolicy(windowAway ? .accessory : .regular)
                app.delegate = delegate
            }
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)),
                styleMask: [.titled, .closable, .miniaturizable, .resizable],
                backing: .buffered,
                defer: false
            )
            window.title = title
            window.isReleasedWhenClosed = false
            window.delegate = windowDelegate
            let content = NSView(frame: window.contentLayoutRect)
            root.view.translatesAutoresizingMaskIntoConstraints = false
            content.addSubview(root.view)
            NSLayoutConstraint.activate([
                root.view.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
                root.view.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
                root.view.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor, constant: -24),
            ])
            window.contentView = content
            if windowAway {
                window.setFrameOrigin(awayOrigin())
            } else {
                window.center()
            }
            self.window = window
            #endif
            #if canImport(UIKit)
            TermViewAppDelegate.pendingRoot = root
            TermViewAppDelegate.pendingTitle = title
            #endif
            return root
        }
    }

    // run `body` once the app is running and its window exists
    static func afterLaunch(_ body: @escaping () -> Void) {
        onMain {
            #if canImport(AppKit)
            DispatchQueue.main.async(execute: body)
            #endif
            #if canImport(UIKit)
            TermViewAppDelegate.afterLaunch.append(body)
            #endif
        }
    }

    // put the window on screen and in front. A test window (TERM_WINDOW_AWAY) is ordered in without taking the keyboard
    // or activating the app, so a run never steals focus from whoever is typing
    static func show() {
        onMain {
            #if canImport(AppKit)
            if windowAway {
                window?.orderFrontRegardless()
            } else {
                window?.makeKeyAndOrderFront(nil)
                NSApplication.shared.activate(ignoringOtherApps: true)
            }
            #endif
        }
    }

    #if canImport(AppKit)
    // TERM_WINDOW_AWAY: the test harnesses set it, so a test app's window opens past the right edge of every screen and
    // never takes focus. A window there is still laid out, drawn, clicked and snapshotted. Unset, nothing changes
    static let windowAway = ProcessInfo.processInfo.environment["TERM_WINDOW_AWAY"] != nil

    // just past the right edge of the rightmost screen, at its bottom
    static func awayOrigin() -> NSPoint {
        let right = NSScreen.screens.map { $0.frame.maxX }.max() ?? 0
        let bottom = NSScreen.screens.map { $0.frame.minY }.min() ?? 0
        return NSPoint(x: right + 200, y: bottom)
    }
    #endif

    // hand the process to the toolkit. Returns only when the app quits
    static func run() {
        onMain {
            setvbuf(stdout, nil, _IONBF, 0)
            #if canImport(AppKit)
            NSApplication.shared.run()
            #endif
            #if canImport(UIKit)
            _ = UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(TermViewAppDelegate.self))
            #endif
        }
    }

    static func exit(_ status: Int) {
        onMain {
            print("native-view exit \(status)")
            Foundation.exit(Int32(status))
        }
    }

    // ---- what a test, or a person, does to the tree and sees of it ----

    static func childAt(_ handle: Any, _ index: Int) -> Any {
        onMain {
            node(handle).children[index]
        }
    }

    // a line to standard output, which is unbuffered once `run` starts
    static func say(_ text: String) {
        onMain {
            print(text)
        }
    }

    // press a control the way a person would: the platform's own click, so the platform's own action runs
    static func press(_ handle: Any) {
        onMain {
            let node = node(handle)
            #if canImport(AppKit)
            if let button = node.view as? NSButton {
                button.performClick(nil)
                return
            }
            #endif
            #if canImport(UIKit)
            if let button = node.view as? UIButton {
                button.sendActions(for: .touchUpInside)
                return
            }
            #endif
            #if canImport(AppKit)
            if let control = node.view as? NSSwitch {
                control.performClick(nil)
                return
            }
            #endif
            #if canImport(UIKit)
            // a tap flips the switch and then reports it, in that order
            if let control = node.view as? UISwitch {
                control.setOn(!control.isOn, animated: false)
                control.sendActions(for: .valueChanged)
                return
            }
            #endif
            node.fire("click")
        }
    }

    // for tests: move a slider the way a finger does, the control first and then its own report of the move
    static func slide(_ handle: Any, _ value: String) {
        onMain {
            let node = node(handle)
            guard let number = Double(value) else { return }
            #if canImport(AppKit)
            if let slider = node.view as? NSSlider {
                slider.doubleValue = number
                slider.sendAction(slider.action, to: slider.target)
            }
            #endif
            #if canImport(UIKit)
            if let slider = node.view as? UISlider {
                slider.setValue(Float(number), animated: false)
                slider.sendActions(for: .valueChanged)
            }
            #endif
        }
    }

    // the tree as HTML, READ BACK FROM THE PLATFORM VIEWS: a button's text is its title as the toolkit holds it and a
    // label's is its string, so this proves the views were updated, not only the model beside them
    static func serialize(_ handle: Any) -> String {
        onMain {
            let node = node(handle)
            switch node.kind {
            case .text:
                #if canImport(AppKit)
                return (node.view as? NSTextField)?.stringValue ?? ""
                #else
                return (node.view as? UILabel)?.text ?? ""
                #endif
            case .button:
                #if canImport(AppKit)
                let title = (node.view as? NSButton)?.title ?? ""
                #else
                // what the button DRAWS, not the title it was asked to show: those two differed while a title animated
                let title = (node.view as? UIButton)?.titleLabel?.text ?? ""
                #endif
                return "<button>\(title)</button>"
            case .field:
                return "<\(node.tag) value=\"\(getValue(node))\"></\(node.tag)>"
            case .toggle:
                #if canImport(AppKit)
                let on = (node.view as? NSSwitch)?.state == .on
                #else
                let on = (node.view as? UISwitch)?.isOn ?? false
                #endif
                return "<switch checked=\"\(on)\"></switch>"
            case .range:
                return "<slider value=\"\(rangeValue(node))\"></slider>"
            case .choice:
                return "<select value=\"\(choiceValue(node))\"></select>"
            case .sheet:
                let shown = node.children.filter { $0.view.superview === node.view }
                return "<sheet open=\"\(presented(node))\">\(shown.map { serialize($0) }.joined())</sheet>"
            case .container:
                let installed = node.children.filter { $0.view.superview === node.view }
                return "<\(node.tag)>\(installed.map { serialize($0) }.joined())</\(node.tag)>"
            case .image:
                // read off the view: the picture it holds, in pixels, and the label the platform reads aloud
                return "<img alt=\"\(label(node))\" size=\"\(pixels(node))\"></img>"
            case .divider:
                return "<hr></hr>"
            case .scroll:
                // the content's laid-out size, so a reader can see it is larger than the frame that scrolls it
                #if canImport(AppKit)
                node.view.window?.contentView?.layoutSubtreeIfNeeded()
                let extent = (node.view as? NSScrollView)?.documentView?.frame.size ?? .zero
                #else
                node.view.window?.layoutIfNeeded()
                let extent = (node.view as? UIScrollView)?.contentSize ?? .zero
                #endif
                let installed = node.children.filter { $0.view.superview === node.box }
                return "<scroll extent=\"\(Int(extent.width.rounded())),\(Int(extent.height.rounded()))\">\(installed.map { serialize($0) }.joined())</scroll>"
            }
        }
    }

    // a PNG of the window's content as drawn
    static func snapshot(_ path: String) {
        onMain {
            #if canImport(AppKit)
            guard let content = window?.contentView else { return }
            // let the platform's own animations land first: NSSwitch slides its knob after a click, and a capture taken at
            // once showed the knob still on the left of a switch that read `on` (2026-10-02)
            RunLoop.current.run(until: Date().addingTimeInterval(0.6))
            content.layoutSubtreeIfNeeded()
            guard let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds) else { return }
            content.cacheDisplay(in: content.bounds, to: bitmap)
            if let png = bitmap.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: path))
            }
            #endif
            #if canImport(UIKit)
            guard let view = window?.rootViewController?.view else { return }
            let renderer = UIGraphicsImageRenderer(bounds: view.bounds)
            let png = renderer.pngData { _ in view.drawHierarchy(in: view.bounds, afterScreenUpdates: true) }
            try? png.write(to: URL(fileURLWithPath: path))
            #endif
        }
    }
}
