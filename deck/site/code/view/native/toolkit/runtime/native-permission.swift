// Permissions on AppKit and UIKit (device-layer-0001), docked by ../permission.tree as `<global:native-permission>`.
//
// A TABLE OF GRANTS, EACH BROUGHT BY ITS CAPABILITY. This runtime names no privacy framework. Each capability's own
// runtime registers the grant it needs, at the top of the program, with how to read it and how to ask for it: the camera
// and the torch `camera` (native-capture.swift's AVFoundation), the microphone `microphone`, location `location`,
// notifications `notification`, contacts `contacts`, the calendar `calendar`, the photo library `photos`. A grant no
// linked capability registered reads `unavailable`, as Android reads a permission the manifest does not declare.
//
// WHY IT IS NOT ONE SWITCH. App Store processing refuses a binary that references a privacy API without the usage
// string for it (ITMS-90683), and the permission runtime is linked into every app that asks for any grant. When this file
// read every grant itself, an app that only posted notifications referenced CoreLocation and AVFoundation and carried
// neither NSLocationWhenInUseUsageDescription nor NSCameraUsageDescription. Now a framework is linked exactly when its
// capability is, which is also when the build writes its usage string (device-layer-0012).
//
// ASKING NEEDS A DECLARATION. iOS and macOS end a process that requests a privacy grant without the usage string its
// Info.plist must carry, and UserNotifications ends a process with no bundle at all. So a request is made only when the
// declaration is there, and otherwise answers the status as it stands, without a prompt.

import Foundation

enum nativePermission {
    // how one grant is read and asked for, and the usage string asking needs (none: a bundle is enough)
    struct Grant {
        let declaration: String?
        let status: () async -> String
        let request: () async -> String
    }

    // filled once, at the top of the program, before anything reads it
    nonisolated(unsafe) private static var grants: [String: Grant] = [:]

    // a capability's runtime registers its grant with this, as a top-level `let _ =`, which runs when the program starts
    @discardableResult
    static func register(_ name: String, declaration: String?, status: @escaping () async -> String, request: @escaping () async -> String) -> Bool {
        grants[name] = Grant(declaration: declaration, status: status, request: request)
        return true
    }

    // the process has a bundle, so the platform has an identity to hold a grant for
    static var bundled: Bool { Bundle.main.bundleIdentifier != nil }

    private static func declared(_ grant: Grant) -> Bool {
        guard let key = grant.declaration else { return bundled }
        return bundled && Bundle.main.object(forInfoDictionaryKey: key) != nil
    }

    static func status(_ name: String) async -> String {
        guard let grant = grants[name] else { return "unavailable" }
        return await grant.status()
    }

    static func request(_ name: String) async -> String {
        guard let grant = grants[name] else { return "unavailable" }
        guard declared(grant) else { return await grant.status() }
        return await grant.request()
    }
}
