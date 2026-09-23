import Observation
import RectoCoreJS
import RectoEditor
import SwiftUI

/// One window's prose-lint result, for the status bar's count.
@MainActor
@Observable
final class ProseLint {
    private(set) var count = 0

    func update(_ count: Int) {
        if count != self.count { self.count = count }
    }
}

/// Runs `lib/lint/analyze` (through the shared JS core) over the window's
/// document 400 ms after the text or the lint settings stop changing, the
/// web's debounce, and hands the findings to the editor's decorations. A
/// zero-size view the host keeps mounted: only it observes the text.
///
/// The core masks code, link targets and frontmatter before linting (plan 004,
/// PR #35), so its offsets are already offsets into the whole source.
struct LintTracker: View {
    typealias Linter = @Sendable (String, [LintCategory]) async throws -> [LintIssue]

    let storage: RectoTextStorage
    let settings: StudioSettings
    let decorations: RectoDecorationController
    let result: ProseLint
    /// Preview shows no marks, as on the web.
    let isLintable: Bool
    var linter: Linter = { markdown, categories in
        try await SharedRectoCore.core().lint(markdown, categories: categories)
    }

    private var categories: [LintCategory] {
        LintCategory.allCases.filter(settings.lintCategories.contains)
    }

    var body: some View {
        let markdown = storage.markdown
        let active = settings.lint && isLintable && !categories.isEmpty
        Color.clear
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
            .task(id: LintInput(markdown: markdown, active: active, categories: categories)) {
                guard active else {
                    decorations.lintMarks = []
                    result.update(0)
                    return
                }
                try? await Task.sleep(for: .milliseconds(400))
                guard !Task.isCancelled,
                      let issues = try? await linter(markdown, categories),
                      !Task.isCancelled
                else { return }
                decorations.lintMarks = issues.map {
                    RectoDecorationController.LintMark(
                        range: NSRange(location: $0.from, length: $0.to - $0.from),
                        category: $0.category,
                        message: $0.message)
                }
                result.update(issues.count)
            }
    }
}

private struct LintInput: Equatable {
    let markdown: String
    let active: Bool
    let categories: [LintCategory]

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.active == rhs.active && lhs.categories == rhs.categories
            && (lhs.markdown as NSString).isEqual(to: rhs.markdown)
    }
}
