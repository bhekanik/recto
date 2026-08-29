import RectoEditor
import SwiftUI

struct EditorHostView: View {
    @Binding private var document: RectoDocument
    @State private var storage: RectoTextStorage
    private let isEditable: Bool

    init(document: Binding<RectoDocument>, isEditable: Bool) {
        self.init(
            document: document,
            isEditable: isEditable,
            storage: RectoTextStorage(
                documentId: UUID().uuidString,
                markdown: document.wrappedValue.markdown
            )
        )
    }

    init(document: Binding<RectoDocument>, isEditable: Bool = true,
         storage: RectoTextStorage) {
        _document = document
        self.isEditable = isEditable
        _storage = State(initialValue: storage)
    }

    var body: some View {
        RectoEditorView(
            storage: storage,
            styler: MarkdownStyler(
                presentation: isEditable ? .rich : .preview,
                theme: .twilight
            ),
            placeholder: "Start writing…",
            onTextChange: { markdown in
                guard document.markdown != markdown else { return }
                document.markdown = markdown
            }
        )
        .frame(minWidth: 720, minHeight: 540)
        .onChange(of: document.markdown) { _, markdown in
            guard storage.markdown != markdown else { return }
            storage.markdown = markdown
        }
    }
}
