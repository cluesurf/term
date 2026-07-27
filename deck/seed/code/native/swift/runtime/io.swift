import Foundation

enum io {
    static func fileRead(_ path: String) -> String {
        return (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
    }
    static func fileWrite(_ path: String, _ data: String) {
        try? data.write(toFile: path, atomically: true, encoding: .utf8)
    }
    static func fileReadBytes(_ path: String) -> Data {
        return (try? Data(contentsOf: URL(fileURLWithPath: path))) ?? Data()
    }
    static func fileWriteBytes(_ path: String, _ data: Data) {
        try? data.write(to: URL(fileURLWithPath: path))
    }
    static func fileAppend(_ path: String, _ data: String) {
        let existing = (try? String(contentsOfFile: path, encoding: .utf8)) ?? ""
        try? (existing + data).write(toFile: path, atomically: true, encoding: .utf8)
    }
    static func fileRemove(_ path: String) {
        try? FileManager.default.removeItem(atPath: path)
    }
    static func fileCopy(_ from: String, _ to: String) {
        try? FileManager.default.copyItem(atPath: from, toPath: to)
    }
    static func fileMove(_ from: String, _ to: String) {
        try? FileManager.default.moveItem(atPath: from, toPath: to)
    }
    static func fileExists(_ path: String) -> Bool {
        return FileManager.default.fileExists(atPath: path)
    }
    static func fileSize(_ path: String) -> Int {
        let attributes = try? FileManager.default.attributesOfItem(atPath: path)
        return (attributes?[.size] as? Int) ?? 0
    }
    static func isDirectory(_ path: String) -> Bool {
        var directory: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: path, isDirectory: &directory)
        return exists && directory.boolValue
    }
    static func isFile(_ path: String) -> Bool {
        var directory: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: path, isDirectory: &directory)
        return exists && !directory.boolValue
    }
    static func dirMake(_ path: String) {
        try? FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    }
    static func dirRemove(_ path: String) {
        try? FileManager.default.removeItem(atPath: path)
    }
    static func dirList(_ path: String) -> [String] {
        return (try? FileManager.default.contentsOfDirectory(atPath: path)) ?? []
    }
    static func dirWalk(_ path: String) -> [String] {
        guard let enumerator = FileManager.default.enumerator(atPath: path) else { return [] }
        var out: [String] = []
        while let entry = enumerator.nextObject() as? String { out.append(path + "/" + entry) }
        return out
    }
}
