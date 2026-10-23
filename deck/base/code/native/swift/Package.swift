// swift-tools-version:5.9
//
// The libraries the Seed stdlib's swift target wraps.
//
// Foundation, Dispatch and CryptoKit are Apple system frameworks swiftc links on its own, so most of the swift
// runtime shims (native/swift/runtime/*.swift) need no package at all, the asynchronous filesystem among them:
// FileManager and POSIX calls handed back to the waiting task from a pool of 4 (aio.swift, decision 001), which is
// what NIOFileSystem was underneath. The one that does is the one with no system answer:
//
//   Hummingbird                the HTTP server. Foundation has no server either, and hand-rolling one over
//                              POSIX sockets is how the previous shim worked: no keep-alive, no chunked bodies,
//                              no TLS, one request per connection.
//   HummingbirdHTTP2           HTTP/2. h2 is negotiated by ALPN, which is why it arrives with NIOSSL.
//   HummingbirdTLS             TLS for the HTTP/1.1 server. Adding these two is what lets `network/https` stop
//                              serving plaintext and apologising for it.
//
// This target exists so `swift build` resolves and builds that graph. It is NOT where the shims live: a shim is a
// source fragment the compiler prepends to an emitted module, not a module of its own. `task/term/native/swift.sh`
// builds this package and turns its output into the include flags the native gate typechecks against.
import PackageDescription

let package = Package(
    name: "TermSwiftRuntime",
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
            name: "TermSwiftRuntime",
            dependencies: [
                .product(name: "NIOCore", package: "swift-nio"),
                .product(name: "NIOPosix", package: "swift-nio"),
                .product(name: "Hummingbird", package: "hummingbird"),
                .product(name: "HummingbirdHTTP2", package: "hummingbird"),
                .product(name: "HummingbirdTLS", package: "hummingbird"),
            ],
            path: "Sources/TermSwiftRuntime"
        )
    ]
)
