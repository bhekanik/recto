import RectoEditor
import SwiftUI

struct EditorHostView: View {
    static let documentID = "accessibility-smoke"

    static let sampleMarkdown = """
    # Recto editor smoke

    This window hosts the real `RectoEditor` package. Use it for the Slice A VoiceOver and Full Keyboard Access checks.

    ## Reading structure

    - A bulleted item
    - A second item with **strong text** and [a link](https://example.com)

    > A block quote for navigation checks.

    ```swift
    let editor = "RectoEditor"
    ```
    """

    @State private var storage: RectoTextStorage

    init(markdown: String = sampleMarkdown) {
        _storage = State(initialValue: RectoTextStorage(
            documentId: Self.documentID,
            markdown: markdown
        ))
    }

    var body: some View {
        RectoEditorView(
            storage: storage,
            styler: MarkdownStyler(presentation: .rich, theme: .twilight),
            placeholder: "Start writing…"
        )
        .frame(minWidth: 720, minHeight: 540)
    }
}
