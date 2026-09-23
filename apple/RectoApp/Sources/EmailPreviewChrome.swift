import RectoEditor
import SwiftUI

/// The inbox row of the web's `EmailPreview` — the email variant of the
/// preview presentation (plan 008). The rendered body below is the preview
/// presentation's own in-place rendering; this chrome frames it the way an
/// inbox would show the message: a placeholder sender, the subject, and the
/// preheader, read from the frontmatter `subject`/`preview`. Preview-only: no
/// recipient, no address, no transport (Recto does not send).
struct EmailPreviewChrome: View {
    let frontmatter: RectoEditor.Frontmatter?
    /// Used when the document has neither subject nor title, like the web's
    /// `fallbackTitle`.
    let fallbackTitle: String
    let theme: RectoEditorTheme

    private var subject: String {
        frontmatter?.subject ?? frontmatter?.title ?? fallbackTitle
    }

    private var preview: String? {
        frontmatter?.preview
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: "You")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color(nsColor: theme.ink2))
                Spacer(minLength: 12)
                Text(verbatim: "Preview")
                    .font(.system(size: 12))
                    .foregroundStyle(Color(nsColor: theme.ink3))
            }
            Text(verbatim: subject)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color(nsColor: theme.ink))
                .lineLimit(1)
                .truncationMode(.tail)
            if let preview {
                Text(verbatim: preview)
                    .font(.system(size: 12))
                    .foregroundStyle(Color(nsColor: theme.ink3))
                    .lineLimit(2)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: theme.raised))
        .overlay(alignment: .bottom) {
            Color(nsColor: theme.line).frame(height: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Email preview: \(subject)")
    }
}