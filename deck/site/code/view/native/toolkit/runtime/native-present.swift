// Putting a controller in front on UIKit (beat-term-0002), docked as `<global:native-present>` by the hosts that show
// one: the share sheet (native-open.swift) and the document picker (native-files.swift). On AppKit there is nothing to
// present: a sheet and an open panel come up on their own, so this holds nothing there.
//
// WHY IT EXISTS. UIKit DROPS a presentation asked of a controller that is still presenting something else, with only a
// console line ("waiting for a delayed presentation"): a share sheet loads its contents before it comes up, and a
// picker asked for meanwhile never appeared, and its pick waited for ever (test/compile/device-transfer.ts). So a
// presentation here is confirmed after it is made, and made again over the new front until it is up.

import Foundation

#if canImport(UIKit)
import UIKit

@MainActor
enum nativePresent {
    // the controller in front: the key window's root, and whatever it has presented, all the way up
    static func topmost() -> UIViewController? {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        guard let window = windows.first(where: \.isKeyWindow) ?? windows.first, var top = window.rootViewController else { return nil }
        while let shown = top.presentedViewController {
            top = shown
        }
        return top
    }

    // `controller` presented over whatever is in front, and true once it is up. The presentation's own completion is
    // the witness: a share sheet and a document picker both come up LATE (each loads a remote view first), so a look
    // soon after asking finds nothing and must not ask again, which UIKit refuses while the first is on its way. A
    // presentation that has not completed in six seconds was dropped, and is asked once more over the new front
    static func whenFree(_ controller: UIViewController) async -> Bool {
        for _ in 0 ..< 2 {
            guard var top = topmost() else { return false }
            // a controller on its way in or out is waited for: presenting over it is what UIKit drops
            var settling = 0
            while top.isBeingPresented || top.isBeingDismissed || top.transitionCoordinator != nil, settling < 30 {
                try? await Task.sleep(nanoseconds: 100_000_000)
                settling += 1
                top = topmost() ?? top
            }
            if let popover = controller.popoverPresentationController, let window = top.view.window {
                popover.sourceView = window
                popover.sourceRect = CGRect(x: window.bounds.midX, y: window.bounds.midY, width: 1, height: 1)
            }
            let once = Once()
            let shown: Bool = await withCheckedContinuation { continuation in
                top.present(controller, animated: true) {
                    once.run { continuation.resume(returning: true) }
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
                    once.run { continuation.resume(returning: false) }
                }
            }
            if shown || controller.presentingViewController != nil {
                return true
            }
        }
        return false
    }
}

// a continuation resumed by whichever comes first, the completion or the deadline, and never twice
@MainActor
final class Once {
    private var done = false

    func run(_ body: () -> Void) {
        guard !done else { return }
        done = true
        body()
    }
}
#endif
