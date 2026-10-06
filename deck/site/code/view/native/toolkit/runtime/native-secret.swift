// Secure storage on AppKit and UIKit (device-layer-0020), docked by ../secret.tree as `<global:native-secret>`. A
// generic password in the Keychain under this app's bundle identifier, readable only while the device is unlocked and
// never synced or restored to another device. A process with no bundle (a test binary) keeps its items under `term`.

import Foundation
import Security

enum nativeSecret {
    private static var service: String { Bundle.main.bundleIdentifier ?? "term" }

    private static func query(_ name: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: name]
    }

    // saved, or failed. A secret saved again under the same name replaces the one before
    static func save(_ name: String, _ value: String) -> String {
        let data = Data(value.utf8)
        let found = SecItemUpdate(query(name) as CFDictionary, [kSecValueData as String: data] as CFDictionary)

        if found == errSecSuccess {
            return "saved"
        }

        guard found == errSecItemNotFound else { return "failed" }
        var item = query(name)
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess ? "saved" : "failed"
    }

    // the value, or empty text when there is none
    static func read(_ name: String) -> String {
        var item = query(name)
        item[kSecReturnData as String] = true
        item[kSecMatchLimit as String] = kSecMatchLimitOne
        var answer: CFTypeRef?
        guard SecItemCopyMatching(item as CFDictionary, &answer) == errSecSuccess, let data = answer as? Data else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    // removed, absent, or failed
    static func remove(_ name: String) -> String {
        switch SecItemDelete(query(name) as CFDictionary) {
        case errSecSuccess: return "removed"
        case errSecItemNotFound: return "absent"
        default: return "failed"
        }
    }
}
