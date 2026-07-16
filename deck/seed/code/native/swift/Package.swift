// swift-tools-version:5.9
// Base libraries the Seed stdlib's swift target wraps. CryptoKit, Foundation (NSRegularExpression, FileManager,
// URLSession) are Apple system frameworks linked automatically by swiftc, so there are no external package deps.
import PackageDescription

let package = Package(
    name: "SeedSwiftRuntime",
    platforms: [.macOS(.v13)],
    targets: [.target(name: "SeedSwiftRuntime", path: "runtime")]
)
