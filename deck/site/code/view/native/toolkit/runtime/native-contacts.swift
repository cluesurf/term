// The person's contacts on AppKit and UIKit (device-layer-0023), docked by ../contacts.tree as `<global:native-contacts>`.
// Every contact is read from CNContactStore and matched here, by the contract's own rule (../../../contacts.tree): its
// full name, as CNContactFormatter writes it, holding the query once both are lowercased. CNContact's own name
// predicate matches words' beginnings, which Android's provider does not, so it is not used. Sorted by name in UTF-16
// code units, the order Kotlin's compareTo gives, so both answer the same list. Without the grant this answers the
// grant's status and never prompts: asking is request-permission's, the one place that does.

import Contacts
import Foundation

// the contacts grant, brought by contacts (native-permission.swift), run when the program starts
nativePermission.register(
    "contacts",
    declaration: "NSContactsUsageDescription",
    status: { nativeContacts.grant() },
    request: {
        _ = try? await CNContactStore().requestAccess(for: .contacts)
        return nativeContacts.grant()
    }
)

enum nativeContacts {
    // compared rather than switched: iOS 18's `.limited` (the person chose which contacts the app sees) is a grant, and
    // is a case only some SDKs name, so a switch either fails to build or warns on one of them
    static func grant() -> String {
        let status = CNContactStore.authorizationStatus(for: .contacts)
        if status == .notDetermined { return "not-determined" }
        if status == .denied { return "denied" }
        if status == .restricted { return "restricted" }
        return "granted"
    }

    // the matching contacts, one a line, `name<TAB>number, number`; or none, not-determined, denied, unavailable, failed
    static func find(_ query: String) async -> String {
        let grant = await nativePermission.status("contacts")
        guard grant == "granted" else { return grant == "restricted" ? "denied" : grant }
        let wanted = query.lowercased()
        let keys: [CNKeyDescriptor] = [CNContactFormatter.descriptorForRequiredKeys(for: .fullName), CNContactPhoneNumbersKey as CNKeyDescriptor]
        var found: [(name: String, numbers: [String])] = []
        do {
            try CNContactStore().enumerateContacts(with: CNContactFetchRequest(keysToFetch: keys)) { contact, _ in
                let name = plain(CNContactFormatter.string(from: contact, style: .fullName) ?? "")
                if wanted.isEmpty || name.lowercased().contains(wanted) {
                    found.append((name, contact.phoneNumbers.map { plain($0.value.stringValue) }))
                }
            }
        } catch {
            return "failed"
        }
        if found.isEmpty { return "none" }
        found.sort { $0.name.utf16.lexicographicallyPrecedes($1.name.utf16) }
        return found.map { "\($0.name)\t\($0.numbers.joined(separator: ", "))" }.joined(separator: "\n")
    }

    // a tab or a line break would split the answer's lines, so each is read as a space
    private static func plain(_ text: String) -> String {
        String(text.map { $0 == "\t" || $0.isNewline ? " " : $0 })
    }
}
