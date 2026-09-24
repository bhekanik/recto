import Observation
import RectoCoreJS

/// One row of the palette.
struct PaletteItem: Identifiable, Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case action(String)
        case document(localId: String)
        /// A document heading, for the `go-to-heading` finder.
        case heading(OutlineHeading)
    }

    enum Detail: Equatable, Sendable {
        /// A keyboard hint, drawn as a key cap.
        case shortcut(String)
        /// Plain trailing text, e.g. a document's word count.
        case text(String)
    }

    let id: String
    let kind: Kind
    let label: String
    let detail: Detail?
    /// What the query is matched against — cmdk's `value`: label, aliases and
    /// section for an action, "document" and the title for a document.
    let searchValue: String
}

extension PaletteItem {
    init(action: CommandAction) {
        self.init(
            id: action.id,
            kind: .action(action.id),
            label: action.label,
            detail: CommandRegistry.shortcut(for: action.id).isEmpty
                ? nil : .shortcut(CommandRegistry.shortcut(for: action.id)),
            searchValue: ([action.label] + action.aliases + [action.section.rawValue]).joined(separator: " ")
        )
    }
}

struct PaletteSection: Equatable, Sendable {
    let title: String
    let items: [PaletteItem]
}

/// The palette's state, without any of its window: the query, what it leaves
/// visible, and which row is selected. Matching is cmdk's default — a
/// case-insensitive substring of the item's value — and the selection wraps
/// like cmdk's `loop`.
@MainActor
@Observable
final class PaletteModel {
    var query = "" {
        didSet {
            guard query != oldValue else { return }
            visibleSections = Self.filter(sections, query: query)
            selectedIndex = 0
        }
    }

    private(set) var visibleSections: [PaletteSection]
    /// Index into ``visibleItems``.
    private(set) var selectedIndex = 0

    @ObservationIgnored private let sections: [PaletteSection]
    @ObservationIgnored private let onRun: (PaletteItem) -> Void
    @ObservationIgnored private let onClose: () -> Void

    init(sections: [PaletteSection], run: @escaping (PaletteItem) -> Void, close: @escaping () -> Void) {
        self.sections = sections
        onRun = run
        onClose = close
        visibleSections = sections
    }

    var visibleItems: [PaletteItem] { visibleSections.flatMap(\.items) }

    var selectedItem: PaletteItem? {
        let items = visibleItems
        return items.indices.contains(selectedIndex) ? items[selectedIndex] : nil
    }

    var hasMatches: Bool { !visibleSections.isEmpty }

    func moveSelection(by delta: Int) {
        let count = visibleItems.count
        guard count > 0 else { return }
        selectedIndex = ((selectedIndex + delta) % count + count) % count
    }

    func select(_ item: PaletteItem) {
        guard let index = visibleItems.firstIndex(of: item) else { return }
        selectedIndex = index
    }

    /// Return on the keyboard, or a click on a row. Runs inside the gesture,
    /// then closes, so an action that needs the window (copy) still has it.
    func run(_ item: PaletteItem) {
        onRun(item)
        onClose()
    }

    func runSelected() {
        guard let selectedItem else { return }
        run(selectedItem)
    }

    func cancel() {
        onClose()
    }

    static func filter(_ sections: [PaletteSection], query: String) -> [PaletteSection] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return sections }
        return sections.compactMap { section in
            let items = section.items.filter { $0.searchValue.lowercased().contains(needle) }
            return items.isEmpty ? nil : PaletteSection(title: section.title, items: items)
        }
    }
}
