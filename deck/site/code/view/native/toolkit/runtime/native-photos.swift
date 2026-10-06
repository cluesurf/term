// The person's photo library on AppKit and UIKit (device-layer-0025), docked by ../photos.tree as `<global:native-photos>`.
// PhotoKit: the newest images by creation date (when taken, else when added), each by its local identifier; a copy is
// the image's original data from PHImageManager, network allowed for one kept in iCloud, written out as a JPEG through
// ImageIO whatever the library kept it as. Times are UTC to the second (../../../photos.tree). Without the grant every
// task answers the grant's status and never prompts: asking is request-permission's, the one place that does.

import Foundation
import ImageIO
import Photos
import UniformTypeIdentifiers

// the photo library grant, brought by the photo library (native-permission.swift), run when the program starts. Read
// and write, the level a library read needs; limited access is a grant
nativePermission.register(
    "photos",
    declaration: "NSPhotoLibraryUsageDescription",
    status: { nativePhotos.grant() },
    request: {
        _ = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        return nativePhotos.grant()
    }
)

enum nativePhotos {
    // compared rather than switched, so a case one SDK adds cannot fail the build on another
    static func grant() -> String {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if status == .authorized || status == .limited { return "granted" }
        if status == .notDetermined { return "not-determined" }
        if status == .restricted { return "restricted" }
        return "denied"
    }

    // the newest `count` photos, `id<TAB>taken<TAB>WIDTHxHEIGHT` a line; or none, or the grant's status
    static func newest(_ count: Int) async -> String {
        if let refused = refusal() { return refused }
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        options.fetchLimit = count
        let found = PHAsset.fetchAssets(with: .image, options: options)
        if found.count == 0 { return "none" }
        var lines: [String] = []
        found.enumerateObjects { asset, _, _ in
            let taken = ISO8601DateFormatter().string(from: asset.creationDate ?? Date(timeIntervalSince1970: 0))
            lines.append("\(plain(asset.localIdentifier))\t\(taken)\t\(asset.pixelWidth)x\(asset.pixelHeight)")
        }
        return lines.joined(separator: "\n")
    }

    // `photo <path>`, a JPEG in the temporary directory; or absent, failed, or the grant's status
    static func export(_ id: String) async -> String {
        if let refused = refusal() { return refused }
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else { return "absent" }
        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.isNetworkAccessAllowed = true
        // the original, not the current rendition: asked for the current one, PhotoKit gave a 321 by 123 photo as a
        // render 320 wide, so the copy was not the photo the library lists
        options.version = .original
        let data: Data? = await withCheckedContinuation { continuation in
            PHImageManager.default().requestImageDataAndOrientation(for: asset, options: options) { data, _, _, _ in
                continuation.resume(returning: data)
            }
        }
        guard let data, let source = CGImageSourceCreateWithData(data as CFData, nil) else { return "failed" }
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("term-photo-\(UUID().uuidString).jpg")
        guard let out = CGImageDestinationCreateWithURL(path as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { return "failed" }
        CGImageDestinationAddImageFromSource(out, source, 0, [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary)
        return CGImageDestinationFinalize(out) ? "photo \(path.path)" : "failed"
    }

    private static func refusal() -> String? {
        let status = grant()
        if status == "granted" { return nil }
        return status == "restricted" ? "denied" : status
    }

    // a tab or a line break would split the answer's lines, so each is read as a space
    private static func plain(_ text: String) -> String {
        String(text.map { $0 == "\t" || $0.isNewline ? " " : $0 })
    }
}
