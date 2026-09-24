import Foundation
import RectoStore

/// The sidebar's documents, filtered by the search field and grouped by when
/// they were last edited: Today, Yesterday, Previous 7 days, Previous 30
/// days, then one group per month. Most recent first within each group.
enum LibraryGroups {
    struct Group: Equatable {
        let title: String
        let documents: [DocumentRecord]
    }

    static func groups(
        _ documents: [DocumentRecord],
        matching query: String = "",
        now: Date = .now,
        calendar: Calendar = .current
    ) -> [Group] {
        let matching = documents
            .filter { matches($0, query) }
            .sorted { $0.updatedAt > $1.updatedAt }
        var order: [String] = []
        var buckets: [String: [DocumentRecord]] = [:]
        for document in matching {
            let title = bucket(for: Date(timeIntervalSince1970: document.updatedAt / 1000), now: now, calendar: calendar)
            if buckets[title] == nil { order.append(title) }
            buckets[title, default: []].append(document)
        }
        return order.map { Group(title: $0, documents: buckets[$0] ?? []) }
    }

    /// Every word of the query appears in the title or the text, ignoring case
    /// and accents: "cafe draft" finds "Café — second draft".
    static func matches(_ document: DocumentRecord, _ query: String) -> Bool {
        let words = query.split(whereSeparator: \.isWhitespace)
        guard !words.isEmpty else { return true }
        let haystack = document.title + "\n" + (document.draftMarkdown ?? document.markdown)
        return words.allSatisfy { haystack.range(of: $0, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
    }

    private static func bucket(for date: Date, now: Date, calendar: Calendar) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return "Today" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(date, inSameDayAs: yesterday) { return "Yesterday" }
        let startOfToday = calendar.startOfDay(for: now)
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: startOfToday).day ?? 0
        if days < 7 { return "Previous 7 days" }
        if days < 30 { return "Previous 30 days" }
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        return date.formatted(sameYear ? .dateTime.month(.wide) : .dateTime.month(.wide).year())
    }
}
