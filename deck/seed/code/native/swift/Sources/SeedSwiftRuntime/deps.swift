// The dependency graph the swift shims compile against, named so `swift build` resolves and builds it. Nothing
// here is called: the shims themselves are fragments prepended to emitted modules, and this target only exists to
// produce the .swiftmodule files the native gate typechecks those modules against. See Package.swift.
import Foundation
import Hummingbird
import NIOCore
import NIOPosix
import _NIOFileSystem

// the versions this stdlib was built against, so a mismatch shows up here rather than inside an emitted module
public enum SeedSwiftRuntime {
    public static let wraps = ["swift-nio", "hummingbird"]
}
