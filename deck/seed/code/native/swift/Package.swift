// swift-tools-version:5.9
//
// The libraries the Seed stdlib's swift target wraps.
//
// Foundation, Dispatch and CryptoKit are Apple system frameworks swiftc links on its own, so most of the swift
// runtime shims (native/swift/runtime/*.swift) need no package at all. The two that do are the ones with no
// system answer:
//
//   NIOFileSystem (swift-nio)  the asynchronous filesystem API. Foundation has none: FileManager and FileHandle
//                              are synchronous, and wrapping them in a Task is a thread pool wearing async
//                              clothing, not asynchronous IO.
//   Hummingbird                the HTTP server. Foundation has no server either, and hand-rolling one over
//                              POSIX sockets is how the previous shim worked: no keep-alive, no chunked bodies,
//                              no TLS, one request per connection.
//
// This target exists so `swift build` resolves and builds that graph. It is NOT where the shims live: a shim is a
// source fragment the compiler prepends to an emitted module, not a module of its own. `task/term/native/swift.sh`
// builds this package and turns its output into the include flags the native gate typechecks against.
import PackageDescription

let package = Package(
    name: "SeedSwiftRuntime",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(
            url: "https://github.com/apple/swift-nio.git",
            from: "2.65.0"
        ),
        .package(
            url: "https://github.com/hummingbird-project/hummingbird.git",
            from: "2.0.0"
        ),
    ],
    targets: [
        .target(
            name: "SeedSwiftRuntime",
            dependencies: [
                .product(name: "NIOCore", package: "swift-nio"),
                .product(name: "NIOPosix", package: "swift-nio"),
                .product(name: "_NIOFileSystem", package: "swift-nio"),
                .product(name: "Hummingbird", package: "hummingbird"),
            ],
            path: "Sources/SeedSwiftRuntime"
        )
    ]
)
