import Foundation
import SwiftUI
import UniformTypeIdentifiers

struct RectoDocument: FileDocument {
    static let markdownContentType = UTType(
        importedAs: "net.daringfireball.markdown",
        conformingTo: .utf8PlainText
    )
    static let readableContentTypes = [markdownContentType]

    var markdown: String
    private var hasUTF8ByteOrderMark: Bool

    init(markdown: String = "", hasUTF8ByteOrderMark: Bool = false) {
        self.markdown = markdown
        self.hasUTF8ByteOrderMark = hasUTF8ByteOrderMark
    }

    init(configuration: ReadConfiguration) throws {
        try self.init(fileWrapper: configuration.file)
    }

    init(fileWrapper: FileWrapper) throws {
        guard fileWrapper.isRegularFile,
              let data = fileWrapper.regularFileContents else {
            throw CocoaError(.fileReadCorruptFile)
        }
        try self.init(fileContents: data)
    }

    init(fileContents: Data) throws {
        let hasUTF8ByteOrderMark = fileContents.starts(with: Self.utf8ByteOrderMark)
        let contents = hasUTF8ByteOrderMark
            ? fileContents.dropFirst(Self.utf8ByteOrderMark.count)
            : fileContents[...]
        guard let markdown = String(data: Data(contents), encoding: .utf8) else {
            throw CocoaError(.fileReadInapplicableStringEncoding)
        }
        self.init(markdown: markdown, hasUTF8ByteOrderMark: hasUTF8ByteOrderMark)
    }

    func fileWrapper(configuration _: WriteConfiguration) throws -> FileWrapper {
        serializedFileWrapper()
    }

    func serializedFileWrapper() -> FileWrapper {
        FileWrapper(regularFileWithContents: encodedData)
    }

    var encodedData: Data {
        var data = hasUTF8ByteOrderMark ? Self.utf8ByteOrderMark : Data()
        data.append(contentsOf: markdown.utf8)
        return data
    }

    private static let utf8ByteOrderMark = Data([0xEF, 0xBB, 0xBF])
}
