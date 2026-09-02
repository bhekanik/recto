/// `lib/markdown/reading-time.ts`, ported: whole minutes at 200 words per
/// minute, rounded up — which is already 1 for any text at all.
enum ReadingTime {
    static let wordsPerMinute = 200

    static func minutes(wordCount: Int) -> Int {
        guard wordCount > 0 else { return 0 }
        return (wordCount + wordsPerMinute - 1) / wordsPerMinute
    }

    /// `formatReadingTime`: "0 min" | "1 min" | "12 min".
    static func format(minutes: Int) -> String {
        "\(minutes) min"
    }
}
