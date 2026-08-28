import AppKit
import Foundation
import RectoVim

/// Headless proof plus the latency numbers.
///
/// Runs the same `keystroke-suite.json` the Bun suite runs, through the real
/// `JSContext`. Bun green + Swift red would mean the bridge is wrong; both
/// green means the bundle behaves identically on both engines.

struct FixtureCase: Decodable {
    let name: String
    let text: String
    let cursor: [Int]
    let keys: String
    let expectText: String
    let expectCursor: [Int]?
    let expectMode: String?
}

struct Fixture: Decodable {
    let cases: [FixtureCase]
}

/// Mirrors the undo model the product uses: the host owns history, so it
/// snapshots before a key that edits and restores on `u`.
@MainActor
final class SuiteHistory: VimHistoryProvider {
    private var undoStack: [(String, Int, Int)] = []
    private var redoStack: [(String, Int, Int)] = []
    private var pending: (String, Int, Int)?
    var current: () -> (String, Int, Int) = { ("", 0, 0) }

    func beginKey() { pending = current() }

    func endKey(_ result: VimResult) {
        if let pending, !result.edits.isEmpty, !result.resynced {
            undoStack.append(pending)
            redoStack.removeAll()
        }
        pending = nil
    }

    func performHistory(_ kind: String) -> (text: String, anchor: Int, head: Int)? {
        if kind == "undo" {
            guard let target = undoStack.popLast() else { return nil }
            redoStack.append(current())
            return target
        }
        guard let target = redoStack.popLast() else { return nil }
        undoStack.append(current())
        return target
    }
}

/// Parses the fixture's vim key notation, same rules as the Bun harness.
func parseKeys(_ spec: String) -> [(String, VimModifiers)] {
    let named: [String: String] = [
        "CR": "Enter", "Enter": "Enter", "Esc": "Escape", "BS": "Backspace",
        "Del": "Delete", "Space": " ", "Tab": "Tab", "Left": "ArrowLeft",
        "Right": "ArrowRight", "Up": "ArrowUp", "Down": "ArrowDown", "lt": "<",
    ]
    var out: [(String, VimModifiers)] = []
    var rest = Substring(spec)
    while let first = rest.first {
        if first == "<", let close = rest.firstIndex(of: ">") {
            var body = String(rest[rest.index(after: rest.startIndex)..<close])
            rest = rest[rest.index(after: close)...]
            var mods: VimModifiers = []
            while body.count > 2, body.dropFirst().first == "-" {
                switch body.first {
                case "C": mods.insert(.control)
                case "A": mods.insert(.option)
                case "M": mods.insert(.command)
                case "S": mods.insert(.shift)
                default: break
                }
                body = String(body.dropFirst(2))
            }
            out.append((named[body] ?? body, mods))
            continue
        }
        let ch = String(first)
        out.append((ch, ch.rangeOfCharacter(from: .uppercaseLetters) != nil ? .shift : []))
        rest = rest.dropFirst()
    }
    return out
}

func offsetToPos(_ text: String, _ offset: Int) -> [Int] {
    let utf16 = Array(text.utf16)
    let clamped = min(max(0, offset), utf16.count)
    var line = 0
    var lastBreak = -1
    for i in 0..<clamped where utf16[i] == 10 {
        line += 1
        lastBreak = i
    }
    return [line, clamped - (lastBreak + 1)]
}

@MainActor
func main() throws {
    guard let fixtureURL = Bundle.module.url(
        forResource: "keystroke-suite", withExtension: "json"
    ) else {
        FileHandle.standardError.write(Data("missing keystroke-suite.json\n".utf8))
        exit(2)
    }
    let fixture = try JSONDecoder().decode(
        Fixture.self, from: try Data(contentsOf: fixtureURL)
    )

    let host = RectoVimHost()
    let history = SuiteHistory()
    host.historyProvider = history
    // Keep the suite off the real pasteboard.
    var clipboard = ""
    host.pasteboardRead = { clipboard }
    host.pasteboardWrite = { clipboard = $0 }

    let engine = try RectoVimEngine(bundleURL: RectoVimEngine.bundledScriptURL(), host: host)
    history.current = {
        let state = try? engine.state()
        let sel = state?.primarySelection ?? VimSelection(anchor: 0, head: 0)
        return (engine.text(), sel.anchor, sel.head)
    }

    print(String(format: "JSContext load: %.2f ms", engine.loadDuration * 1000))

    var passed = 0
    var failures: [String] = []

    for testCase in fixture.cases {
        try engine.start(text: testCase.text)
        try engine.setCursor(line: testCase.cursor[0], ch: testCase.cursor[1])
        var last = try engine.state()
        for (key, mods) in parseKeys(testCase.keys) {
            history.beginKey()
            last = try engine.handleKey(key, mods: mods)
            history.endKey(last)
        }
        let text = engine.text()
        let cursor = offsetToPos(text, last.primarySelection.head)

        var problems: [String] = []
        if text != testCase.expectText {
            problems.append("text \(debugString(text)) != \(debugString(testCase.expectText))")
        }
        if let want = testCase.expectCursor, cursor != want {
            problems.append("cursor \(cursor) != \(want)")
        }
        if let want = testCase.expectMode, last.mode != want {
            problems.append("mode \(last.mode) != \(want)")
        }
        if problems.isEmpty {
            passed += 1
        } else {
            failures.append("  \(testCase.name): \(problems.joined(separator: "; "))")
        }
    }

    print("keystroke suite: \(passed)/\(fixture.cases.count) passing")
    for failure in failures { print(failure) }

    print("")
    let textViewOK = try TextViewProof.run()

    try benchmark(engine: engine)

    if !failures.isEmpty || !textViewOK { exit(1) }
}

func debugString(_ s: String) -> String {
    "\"\(s.replacingOccurrences(of: "\n", with: "\\n"))\""
}

/// Per-keystroke round trip, at three document sizes.
///
/// Size matters here because the JS-side mirror re-splits the buffer into lines
/// on every edit, which is O(document). If that dominated, the whole
/// keep-the-buffer-in-JS design would be wrong, so it is measured rather than
/// assumed. `applyToStorage` additionally writes each edit into a real
/// `NSTextStorage`, which is the other half of the "keyDown → … → back" path.
@MainActor
func benchmark(engine: RectoVimEngine) throws {
    let paragraph = """
    The quick brown fox jumps over the lazy dog. Pack my box with five dozen \
    liquor jugs. How vexingly quick daft zebras jump!
    """

    // A realistic mix: motions, an operator, insert-mode typing, then Escape.
    let script: [(String, VimModifiers)] = [
        ("j", []), ("j", []), ("w", []), ("w", []), ("e", []), ("b", []),
        ("d", []), ("w", []),
        ("i", []), ("a", []), ("b", []), ("c", []), ("Escape", []),
        ("x", []), ("0", []), ("$", []), ("k", []),
    ]

    var loads = [Double](repeating: 0, count: 3)
    getloadavg(&loads, 3)
    print(String(format: "\nload average at measurement: %.2f %.2f %.2f (times in ms)",
                 loads[0], loads[1], loads[2]))
    for (label, repeats) in [("2.6k words", 120), ("10k words", 460), ("150k words (950 kB)", 6900)] {
        let document = Array(repeating: paragraph, count: repeats).joined(separator: "\n\n")
        let words = document.split(separator: " ").count
        let lines = document.components(separatedBy: "\n").count
        print("--- \(label): \(document.utf16.count) UTF-16 units, ~\(words) words, \(lines) lines")

        for applyToStorage in [false, true] {
            let storage = NSTextStorage(string: document)
            try engine.start(text: document)
            var samples: [Double] = []
            // Warm up JSC's JIT; the first few hundred keys run interpreted and
            // are not what a typing session looks like.
            let warmup = 400
            let iterations = 1600
            var wallSamples: [Double] = []
            for i in 0..<(warmup + iterations) {
                let (key, mods) = script[i % script.count]
                let cpuStart = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
                let wallStart = DispatchTime.now()
                let result = try engine.handleKey(key, mods: mods)
                if applyToStorage, !result.edits.isEmpty {
                    storage.beginEditing()
                    for edit in result.edits {
                        storage.replaceCharacters(in: edit.range, with: edit.insert)
                    }
                    storage.endEditing()
                }
                let cpu = Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - cpuStart) / 1_000_000
                let wall = RectoVimEngine.seconds(since: wallStart) * 1000
                if i >= warmup {
                    samples.append(cpu)
                    wallSamples.append(wall)
                }
            }
            // The mirror and the storage must still agree, or the numbers are
            // measuring something that would corrupt a document.
            if applyToStorage, storage.string != engine.text() {
                print("    MIRROR DIVERGED from NSTextStorage")
                exit(1)
            }
            samples.sort()
            wallSamples.sort()
            func pct(_ xs: [Double], _ q: Double) -> Double {
                xs[min(xs.count - 1, Int(Double(xs.count) * q))]
            }
            print(String(
                format: "    %@  n=%d  cpu p50 %.4f  p95 %.4f  p99 %.4f | wall p50 %.4f  p95 %.4f",
                applyToStorage ? "bridge + NSTextStorage" : "bridge only            ",
                samples.count,
                pct(samples, 0.50), pct(samples, 0.95), pct(samples, 0.99),
                pct(wallSamples, 0.50), pct(wallSamples, 0.95)
            ))
        }
    }
}

try MainActor.assumeIsolated { try main() }
