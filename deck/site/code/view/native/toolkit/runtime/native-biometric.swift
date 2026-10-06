// Biometrics on AppKit and UIKit (device-layer-0021), docked by ../biometric.tree as `<global:native-biometric>`.
// LocalAuthentication with the biometric policy alone, so the sheet is Face ID or Touch ID and never falls back to the
// device passcode, which is not a biometric. An app that reaches this needs NSFaceIDUsageDescription in its Info.plist,
// which the build writes (device-declare.ts).

import Foundation
import LocalAuthentication

enum nativeBiometric {
    // the hardware, face, fingerprint or none, without showing anything. Whether anything is enrolled is authenticate's
    // to say
    static func kind() -> String {
        let context = LAContext()
        var error: NSError?
        // asked first, since biometryType is only filled once the policy has been evaluated for
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)

        switch context.biometryType {
        case .faceID: return "face"
        case .touchID: return "fingerprint"
        case .none: return "none"
        default: return "unavailable"
        }
    }

    // passed, failed, not-enrolled or unavailable
    static func authenticate(_ reason: String) async -> String {
        let context = LAContext()
        var error: NSError?

        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            switch error?.code {
            case LAError.biometryNotEnrolled.rawValue: return "not-enrolled"
            case LAError.biometryLockout.rawValue: return "failed"
            default: return "unavailable"
            }
        }

        do {
            return try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) ? "passed" : "failed"
        } catch {
            return "failed"
        }
    }
}
