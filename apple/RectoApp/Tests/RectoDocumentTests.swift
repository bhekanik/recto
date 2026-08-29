import Foundation
import Testing
@testable import Recto

@Suite("Markdown file document")
struct RectoDocumentTests {
    @Test("UTF-8 Markdown round-trips without changing Unicode or line endings", arguments: [
        "# Café 世界\n\n[link](https://example.com/a) and `code`\n",
        "# Café 世界\r\n\r\n[link](https://example.com/a) and `code`\r\n",
    ])
    func utf8RoundTrip(markdown: String) throws {
        let source = Data(markdown.utf8)
        let sourceWrapper = FileWrapper(regularFileWithContents: source)
        let document = try RectoDocument(fileWrapper: sourceWrapper)
        let serializedWrapper = document.serializedFileWrapper()

        #expect(document.markdown == markdown)
        #expect(serializedWrapper.isRegularFile)
        #expect(serializedWrapper.regularFileContents == source)
    }

    @Test("invalid UTF-8 is rejected instead of replaced")
    func invalidUTF8IsRejected() {
        #expect(throws: (any Error).self) {
            try RectoDocument(fileWrapper: FileWrapper(
                regularFileWithContents: Data([0x23, 0x20, 0xFF, 0x0A])
            ))
        }
    }

    @Test("UTF-8 byte-order mark is accepted and preserved")
    func byteOrderMarkIsPreserved() throws {
        let source = Data([0xEF, 0xBB, 0xBF]) + Data("# Café 世界\r\n".utf8)
        var document = try RectoDocument(fileContents: source)

        #expect(document.markdown == "# Café 世界\r\n")
        #expect(document.encodedData == source)

        document.markdown += "Edited ✅\r\n"
        #expect(document.encodedData.starts(with: Data([0xEF, 0xBB, 0xBF])))
        #expect(document.encodedData == source + Data("Edited ✅\r\n".utf8))
    }

    @Test("directory wrappers fail instead of becoming empty documents")
    func directoryWrapperIsRejected() {
        #expect(throws: CocoaError.self) {
            try RectoDocument(fileWrapper: FileWrapper(directoryWithFileWrappers: [:]))
        }
    }
}
