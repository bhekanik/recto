import Testing
@testable import Recto

@Suite("Editor host")
@MainActor
struct EditorHostViewTests {
    @Test("ships structured content for the manual accessibility smoke")
    func accessibilitySample() {
        #expect(EditorHostView.documentID == "accessibility-smoke")
        #expect(EditorHostView.sampleMarkdown.contains("# Recto editor smoke"))
        #expect(EditorHostView.sampleMarkdown.contains("- A bulleted item"))
        #expect(EditorHostView.sampleMarkdown.contains("> A block quote"))
        #expect(EditorHostView.sampleMarkdown.contains("```swift"))
    }
}
