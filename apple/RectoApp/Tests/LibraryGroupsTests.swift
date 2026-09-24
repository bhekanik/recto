import Foundation
import RectoStore
import Testing
@testable import Recto

@Suite("Library groups and search")
struct LibraryGroupsTests {
    private let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/London")!
        return calendar
    }()

    /// Noon, Thursday 24 September 2026, London.
    private var now: Date {
        calendar.date(from: DateComponents(year: 2026, month: 9, day: 24, hour: 12))!
    }

    private func document(_ id: String, _ title: String, daysAgo: Double, text: String = "") -> DocumentRecord {
        let updated = now.addingTimeInterval(-daysAgo * 86_400).timeIntervalSince1970 * 1000
        return DocumentRecord(
            localId: id, title: title, markdown: text, wordCount: 0,
            localHeadNodeId: "head-\(id)", updatedAt: updated, createdAt: updated)
    }

    @Test("most recent first, bucketed by when it was edited")
    func grouping() {
        let documents = [
            document("june", "June notes", daysAgo: 100),
            document("today", "This morning", daysAgo: 0.1),
            document("yesterday", "Last night", daysAgo: 1),
            document("week", "Monday", daysAgo: 3),
            document("month", "Early September", daysAgo: 20),
            document("lastYear", "Old", daysAgo: 400),
        ]
        let groups = LibraryGroups.groups(documents, now: now, calendar: calendar)
        #expect(groups.map(\.title) == [
            "Today", "Yesterday", "Previous 7 days", "Previous 30 days", "June", "August 2025",
        ])
        #expect(groups.map { $0.documents.map(\.localId) } == [
            ["today"], ["yesterday"], ["week"], ["month"], ["june"], ["lastYear"],
        ])
    }

    @Test("search matches every word in the title or text, ignoring case and accents")
    func search() {
        let documents = [
            document("a", "Café — second draft", daysAgo: 0),
            document("b", "Reading list", daysAgo: 0, text: "Notes on quiet software"),
            document("c", "Weekly letter", daysAgo: 0),
        ]
        func ids(_ query: String) -> [String] {
            LibraryGroups.groups(documents, matching: query, now: now, calendar: calendar)
                .flatMap(\.documents).map(\.localId).sorted()
        }
        #expect(ids("") == ["a", "b", "c"])
        #expect(ids("cafe DRAFT") == ["a"])
        #expect(ids("quiet") == ["b"], "the text counts, not just the title")
        #expect(ids("letter draft").isEmpty, "every word has to match")
    }
}
