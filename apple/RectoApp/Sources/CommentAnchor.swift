import Foundation

/// `lib/review/anchor.ts`: a comment is stored as its quoted text plus a little
/// context, not a bare offset, so it survives edits around or inside the quote.
/// Offsets are UTF-16, the web's string indices, because the anchor is stored
/// on the server and read by both apps.
///
/// The load-bearing rule: never mis-anchor. When the quote cannot be found
/// with confidence, `locate` returns nil and the comment shows as "anchor lost".
struct CommentAnchor: Codable, Equatable, Sendable {
    var quote: String
    var prefix: String
    var suffix: String
    /// Where the quote started when anchored; a tie-breaker, never authoritative.
    var offsetHint: Double

    static let contextLength = 32
    static let maxQuoteLength = 200
    /// Below this normalized score the fuzzy fallback orphans rather than guesses.
    static let fuzzyMinScore = 0.5

    /// `createAnchor`. An empty range grows to the word around the caret.
    static func create(in markdown: String, from: Int, to: Int) -> CommentAnchor {
        let text = markdown as NSString
        var start = max(0, min(from, text.length))
        var end = max(0, min(to, text.length))
        if start > end { swap(&start, &end) }
        if start == end {
            while start > 0, isWordUnit(text.character(at: start - 1)) { start -= 1 }
            while end < text.length, isWordUnit(text.character(at: end)) { end += 1 }
        }
        if end - start > maxQuoteLength { end = start + maxQuoteLength }
        return CommentAnchor(
            quote: text.substring(with: NSRange(location: start, length: end - start)),
            prefix: text.substring(with: NSRange(location: max(0, start - contextLength), length: start - max(0, start - contextLength))),
            suffix: text.substring(with: NSRange(location: end, length: min(text.length, end + contextLength) - end)),
            offsetHint: Double(start))
    }

    private static func isWordUnit(_ unit: unichar) -> Bool {
        guard let scalar = Unicode.Scalar(unit) else { return false }
        return scalar == "_" || CharacterSet.letters.contains(scalar) || CharacterSet.decimalDigits.contains(scalar)
    }

    /// `locateAnchor`: exact and unique; else the occurrence whose context
    /// matches best (nearest the hint on a tie); else a fuzzy near-match around
    /// the hint; else nil.
    func locate(in markdown: String) -> NSRange? {
        guard !quote.isEmpty else { return nil }
        let text = markdown as NSString
        let length = (quote as NSString).length
        var occurrences: [Int] = []
        var search = NSRange(location: 0, length: text.length)
        while true {
            let found = text.range(of: quote, options: .literal, range: search)
            guard found.location != NSNotFound else { break }
            occurrences.append(found.location)
            let next = found.location + 1
            guard next < text.length else { break }
            search = NSRange(location: next, length: text.length - next)
        }
        if occurrences.count == 1 { return NSRange(location: occurrences[0], length: length) }
        if occurrences.count > 1 {
            let best = occurrences.max { a, b in
                let scoreA = contextScore(text, a, length), scoreB = contextScore(text, b, length)
                if scoreA != scoreB { return scoreA < scoreB }
                return abs(Double(a) - offsetHint) > abs(Double(b) - offsetHint)
            }!
            return NSRange(location: best, length: length)
        }
        return fuzzyLocate(text)
    }

    private func contextScore(_ text: NSString, _ start: Int, _ length: Int) -> Int {
        let before = Array(text.substring(with: NSRange(location: max(0, start - Self.contextLength), length: start - max(0, start - Self.contextLength))).utf16)
        let afterStart = start + length
        let after = Array(text.substring(with: NSRange(location: afterStart, length: min(text.length, afterStart + Self.contextLength) - afterStart)).utf16)
        let prefix = Array(prefix.utf16), suffix = Array(suffix.utf16)
        var common = 0
        while common < before.count, common < prefix.count,
              before[before.count - 1 - common] == prefix[prefix.count - 1 - common] { common += 1 }
        var leading = 0
        while leading < after.count, leading < suffix.count, after[leading] == suffix[leading] { leading += 1 }
        return common + leading
    }

    private func fuzzyLocate(_ text: NSString) -> NSRange? {
        guard text.length > 0 else { return nil }
        let normalizedQuote = Self.normalize(quote)
        guard !normalizedQuote.isEmpty else { return nil }
        let window = (quote as NSString).length
        let hint = Int(offsetHint)
        let slack = max(window * 2, Self.contextLength * 2, 64)
        let regionStart = max(0, hint - slack)
        let regionEnd = min(text.length, hint + window + slack)
        let step = window > 24 ? 2 : 1
        var best: (start: Int, end: Int, score: Double)?
        var start = regionStart
        while start + 1 <= regionEnd {
            for candidateLength in Self.candidateLengths(window) {
                let end = min(text.length, start + candidateLength)
                guard end > start else { continue }
                let candidate = Self.normalize(text.substring(with: NSRange(location: start, length: end - start)))
                guard !candidate.isEmpty else { continue }
                let score = Self.dice(normalizedQuote, candidate)
                if score > (best?.score ?? 0) { best = (start, end, score) }
                if end >= text.length { break }
            }
            start += step
        }
        guard let best, best.score >= Self.fuzzyMinScore else { return nil }
        return NSRange(location: best.start, length: best.end - best.start)
    }

    private static func candidateLengths(_ base: Int) -> [Int] {
        guard base > 4 else { return [base] }
        let delta = max(2, Int((Double(base) * 0.15).rounded()))
        return [base, base - delta, base + delta].filter { $0 > 0 }
    }

    /// Collapse whitespace, trim, lowercase: `normalize` on the web.
    private static func normalize(_ string: String) -> [UInt16] {
        let collapsed = string.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return Array(collapsed.utf16)
    }

    /// Dice coefficient over UTF-16 bigrams, the web's `diceCoefficient`.
    private static func dice(_ a: [UInt16], _ b: [UInt16]) -> Double {
        if a == b { return 1 }
        guard a.count >= 2, b.count >= 2 else { return 0 }
        var bigrams: [UInt32: Int] = [:]
        for i in 0..<(a.count - 1) { bigrams[UInt32(a[i]) << 16 | UInt32(a[i + 1]), default: 0] += 1 }
        var intersection = 0
        for i in 0..<(b.count - 1) {
            let key = UInt32(b[i]) << 16 | UInt32(b[i + 1])
            if let count = bigrams[key], count > 0 {
                bigrams[key] = count - 1
                intersection += 1
            }
        }
        return Double(2 * intersection) / Double(a.count - 1 + b.count - 1)
    }
}
