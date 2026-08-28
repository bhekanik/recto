import AppKit
import Foundation

/// The N0b measurement run. Every number is wall-clock on the main thread with
/// `CACurrentMediaTime()`, in a Release build, driving the real AppKit event
/// path — synthesised `NSEvent`s through `NSWindow.sendEvent`, not
/// `insertText:` — and forcing the viewport to lay out and draw before the
/// clock stops.
@MainActor
enum Measure {
    static func run(corpusDir: URL) {
        let h = Harness.make(fontSize: 19, readingWidth: 720, activate: false)
        print("# EditorSpike N0b — swift-markdown-engine")
        print("host: \(hostDescription())")
        print("prose font: \(h.fontName) 19pt, reading column 720pt, window 1200x900")
        print("window visible to the compositor: \(h.window.occlusionState.contains(.visible))")
        print(String(format: "footprint at start: %.1f MB", footprintMB()))
        print("")

        corpusPass(h, dir: corpusDir)
        dialectProbe(h, dir: corpusDir)

        let loadURL = corpusDir.appendingPathComponent("load-10k.md")
        guard let big = try? String(contentsOf: loadURL, encoding: .utf8) else {
            print("MISSING \(loadURL.path)")
            return
        }

        h.load("")
        pump(0.2)
        let memBefore = footprintMB()
        // Two different questions. Opening a document only has to lay out the
        // viewport — that is what the reader waits for. Laying out all 812
        // fragments is what an app pays for a full-document operation (export,
        // outline, jump to the end) and is where the memory actually goes.
        let coldOpen = h.load(big, fullLayout: false)
        let memOpenPeak = footprintMB()
        let memOpenSettled = settledFootprintMB()
        let t0 = CACurrentMediaTime()
        h.layoutWholeDocument()
        h.display()
        let fullLayoutMs = (CACurrentMediaTime() - t0) * 1000
        let memFull = settledFootprintMB()

        h.load("")
        pump(0.2)
        let warmOpen = h.load(big, fullLayout: false)
        pump(0.2)
        let ns = big as NSString
        print("## 10k-word document")
        print(
            String(
                format: "  chars=%d  lines=%d  fragments=%d",
                ns.length, ns.components(separatedBy: "\n").count, h.fragmentCount()))
        print(String(format: "  open + viewport layout, first ever open: %.1f ms", coldOpen))
        print(String(format: "  open + viewport layout, second open:     %.1f ms", warmOpen))
        print(String(format: "  then full-document layout of all fragments: %.1f ms", fullLayoutMs))
        print(
            String(
                format:
                    "  footprint: %.1f MB empty → %.1f MB peak during open → %.1f MB settled → %.1f MB after full-document layout",
                memBefore, memOpenPeak, memOpenSettled, memFull))
        print("")
        h.load(big)
        pump(0.1)

        let spots = Spots(in: ns)
        print("probe offsets: \(spots.describe(ns))")
        print("")
        markerProof(h, spots: spots, ns: ns)

        typing(h, at: spots.paragraph, label: "typing — plain paragraph")
        h.load(big)
        pump(0.1)
        typing(h, at: spots.listItem, label: "typing — list item near code/table")
        h.load(big)
        pump(0.1)
        typingMarkers(h, at: spots.paragraph)
        h.load(big)
        pump(0.1)

        print(String(format: "footprint after ~1100 keystrokes (settled): %.1f MB", settledFootprintMB()))
        print("")

        reveal(h, spots: spots, ns: ns)
        caretWalk(h, spots: spots, ns: ns)
        scroll(h)

        print(String(format: "footprint at end (settled): %.1f MB", settledFootprintMB()))
    }

    // MARK: - corpus

    /// The canonical cases, without the generated load document.
    private static func corpusFiles(in dir: URL) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [])
            .filter { $0.hasSuffix(".md") && $0 != "load-10k.md" }
            .sorted()
    }

    private static func corpusPass(_ h: Harness, dir: URL) {
        let files = corpusFiles(in: dir)
        print("## corpus (\(files.count) canonical cases)")
        for name in files {
            guard
                let text = try? String(
                    contentsOf: dir.appendingPathComponent(name), encoding: .utf8)
            else { continue }
            let ms = h.load(text)
            let stored = h.textView.string
            // The engine must never rewrite the string it was handed: markers
            // shrink, they are not deleted. Any difference is a losslessness bug.
            let lossless = stored == text
            print(
                String(
                    format: "  %-52@ %6.1f ms  frags=%-4d %@", name as NSString, ms,
                    h.fragmentCount(), lossless ? "text preserved" : "TEXT CHANGED"))
            if !lossless {
                print("      stored: \(stored.debugDescription.prefix(200))")
            }
        }
        print("")
    }

    /// What the reader actually sees, per corpus case. A character the styler
    /// shrank or painted clear is printed as `·`; anything left at full size is
    /// literal syntax on screen. This is how we find the constructs the engine's
    /// parser does not recognise, without trusting a code read.
    private static func dialectProbe(_ h: Harness, dir: URL) {
        print("## what the reader sees (`·` = marker hidden by the styler)")
        for name in corpusFiles(in: dir) {
            guard
                let text = try? String(
                    contentsOf: dir.appendingPathComponent(name), encoding: .utf8)
            else { continue }
            h.load(text)
            let ns = text as NSString
            // Park the caret at the end so no block is revealed by proximity.
            h.textView.setSelectedRange(NSRange(location: ns.length, length: 0))
            h.display()
            guard let storage = h.textView.textStorage else { continue }
            var shown = ""
            for i in 0..<ns.length {
                let ch = ns.substring(with: NSRange(location: i, length: 1))
                let size =
                    (storage.attribute(.font, at: i, effectiveRange: nil) as? NSFont)?.pointSize ?? 19
                let color = storage.attribute(.foregroundColor, at: i, effectiveRange: nil) as? NSColor
                let invisible = size < 6 || (color?.alphaComponent ?? 1) < 0.01
                if ch == "\n" {
                    shown += "⏎"
                } else {
                    shown += invisible ? "·" : ch
                }
            }
            print("  \(name)")
            print("    \(shown)")
        }
        print("")
    }

    /// Prove the markers are actually hidden and revealed before believing any
    /// timing above. Reads the font size the styler left on the marker
    /// characters with the caret away from the block, then inside it.
    private static func markerProof(_ h: Harness, spots: Spots, ns: NSString) {
        func sizes(_ label: String, _ range: NSRange, caretIn: Int) {
            h.textView.setSelectedRange(NSRange(location: spots.paragraph, length: 0))
            h.display()
            let away = h.fontSizes(in: range)
            h.textView.setSelectedRange(NSRange(location: caretIn, length: 0))
            h.display()
            let inside = h.fontSizes(in: range)
            print(
                "  \(label) \(ns.substring(with: range).debugDescription): caret away \(away) pt → caret inside \(inside) pt"
            )
        }
        print("## marker hiding (font size the styler leaves on the marker characters)")
        sizes(
            "heading prefix", NSRange(location: spots.headingLineStart, length: 3),
            caretIn: spots.headingText + 2)
        sizes(
            "emphasis open", NSRange(location: spots.emphasisStart, length: 2),
            caretIn: spots.emphasisText)
        print("")
    }

    // MARK: - typing

    private static func typing(_ h: Harness, at location: Int, label: String) {
        h.textView.setSelectedRange(NSRange(location: location, length: 0))
        h.center(on: location)
        pump(0.05)

        let phrase = Array("the quick brown fox jumps over the lazy dog ")
        var edit = Samples()
        var total = Samples()
        var settle = Samples()
        var caretAnomalies = 0
        var previous = h.textView.selectedRange().location

        var memoryCurve: [String] = [String(format: "%.0f", footprintMB())]

        for i in 0..<240 {
            // Each keystroke gets its own pool: without one, transient copies of
            // the 66 kB document pile up and the footprint reads as a leak.
            autoreleasepool {
                let ch = String(phrase[i % phrase.count])
                let t0 = CACurrentMediaTime()
                h.key(ch)
                let t1 = CACurrentMediaTime()
                h.display()
                let t2 = CACurrentMediaTime()
                // Warm-up: the first few keystrokes pay one-off caches.
                if i >= 20 {
                    edit.add((t1 - t0) * 1000)
                    total.add((t2 - t0) * 1000)
                }
                let t3 = CACurrentMediaTime()
                pump(0.002)
                if i >= 20 { settle.add((CACurrentMediaTime() - t3) * 1000) }
            }
            if (i + 1) % 60 == 0 { memoryCurve.append(String(format: "%.0f", footprintMB())) }

            let now = h.textView.selectedRange().location
            if now != previous + 1 { caretAnomalies += 1 }
            previous = now
        }
        let beforeUndoDrop = footprintMB()
        h.textView.undoManager?.removeAllActions()
        pump(0.05)
        print("## \(label)")
        print(
            "  footprint every 60 keystrokes: \(memoryCurve.joined(separator: " → ")) MB"
                + String(format: ", %.0f MB after dropping the undo stack", footprintMB())
                + String(format: " (was %.0f)", beforeUndoDrop))
        print("  " + edit.line("keystroke → styled (event only)"))
        print("  " + total.line("keystroke → drawn (headline)"))
        print("  " + settle.line("async settle after the frame"))
        print("  frames over 16.67 ms: \(total.over(16.67))/\(total.count)")
        print("  caret advanced by exactly 1 on every keystroke: \(caretAnomalies == 0)")
        print("")
    }

    /// Typing the markers themselves: the moment the run closes, the engine has
    /// to shrink two markers and restyle the span under the caret.
    private static func typingMarkers(_ h: Harness, at location: Int) {
        h.textView.setSelectedRange(NSRange(location: location, length: 0))
        h.center(on: location)
        pump(0.05)
        var total = Samples()
        var closing = Samples()
        let before = (h.textView.string as NSString).length

        for round in 0..<30 {
            let seq = Array(" **bold** and *thin* text")
            for (i, ch) in seq.enumerated() {
                autoreleasepool {
                    let t0 = CACurrentMediaTime()
                    h.key(String(ch))
                    h.display()
                    let ms = (CACurrentMediaTime() - t0) * 1000
                    if round >= 3 {
                        total.add(ms)
                        // The keystroke that closes `**bold**` / `*thin*`.
                        if ch == "*" && i > 0 && seq[i - 1] == "d" { closing.add(ms) }
                    }
                    pump(0.002)
                }
            }
        }
        let after = (h.textView.string as NSString).length
        print("## typing — emphasis markers")
        print("  " + total.line("keystroke → drawn"))
        print("  " + closing.line("the keystroke that closes a run"))
        print("  chars added: \(after - before) (auto-pairing changes this)")
        print("")
    }

    // MARK: - reveal / hide

    private static func reveal(_ h: Harness, spots: Spots, ns: NSString) {
        h.center(on: spots.heading)
        pump(0.05)

        var headingIn = Samples()
        var headingOut = Samples()
        var emphasisIn = Samples()
        var emphasisOut = Samples()
        var mismatches = 0
        var probeRects: [NSRect] = []
        var charAtEmphasis = Set<String>()

        func move(_ location: Int, into s: inout Samples) {
            let target = NSRange(location: location, length: 0)
            let t0 = CACurrentMediaTime()
            h.textView.setSelectedRange(target)
            h.display()
            s.add((CACurrentMediaTime() - t0) * 1000)
            if h.textView.selectedRange() != target { mismatches += 1 }
        }

        for _ in 0..<80 {
            move(spots.headingText, into: &headingIn)
            move(spots.paragraph, into: &headingOut)
            probeRects.append(h.caretRect())
            move(spots.emphasisText, into: &emphasisIn)
            charAtEmphasis.insert(ns.substring(with: NSRange(location: spots.emphasisText, length: 1)))
            move(spots.paragraph, into: &emphasisOut)
            probeRects.append(h.caretRect())
        }

        print("## marker reveal / hide (caret move, no edit)")
        print("  " + headingIn.line("caret into heading (reveal ##)"))
        print("  " + headingOut.line("caret out of heading (hide)"))
        print("  " + emphasisIn.line("caret into **emphasis** (reveal)"))
        print("  " + emphasisOut.line("caret out of emphasis (hide)"))
        print("  selection landed exactly where asked: \(mismatches == 0) (\(mismatches) mismatches)")

        let distinct = Set(probeRects.map { "\(Int($0.origin.x.rounded()))x\(Int($0.origin.y.rounded()))" })
        print(
            "  caret rect at the fixed probe across \(probeRects.count) reveal/hide cycles: \(distinct.count) distinct position(s) \(distinct.sorted().prefix(4))"
        )
        print("  character under the caret inside the emphasis run: \(charAtEmphasis.sorted())")
        print("")
    }

    /// Walk the caret with the right-arrow key across a heading prefix and an
    /// emphasis run and print the offsets it actually visits. Hidden markers are
    /// still characters, so a well-behaved engine visits every one of them.
    private static func caretWalk(_ h: Harness, spots: Spots, ns: NSString) {
        func walk(_ start: Int, _ steps: Int, _ label: String) {
            h.textView.setSelectedRange(NSRange(location: start, length: 0))
            h.display()
            var offsets: [Int] = [h.textView.selectedRange().location]
            for _ in 0..<steps {
                h.key(
                    String(utf16CodeUnits: [unichar(NSRightArrowFunctionKey)], count: 1),
                    keyCode: 124, flags: .function)
                h.display()
                offsets.append(h.textView.selectedRange().location)
            }
            let deltas = zip(offsets, offsets.dropFirst()).map { $1 - $0 }
            let text = ns.substring(with: NSRange(location: start, length: steps))
            print("  \(label)")
            print("    source: \(text.debugDescription)")
            print("    caret deltas: \(deltas)")
        }

        print("## caret walk (→ key, one press per column)")
        walk(spots.headingLineStart, 14, "across a `## ` heading prefix")
        walk(spots.emphasisStart, 12, "across a `**bold**` run")
        print("")
    }

    // MARK: - scroll

    private static func scroll(_ h: Harness) {
        print("## scroll through the whole 10k-word document")
        let cold = scrollPass(h, forceFullRedraw: false)
        print("  " + cold.line("scroll step → drawn"))
        print("  frames over 16.67 ms (60 fps budget): \(cold.over(16.67))/\(cold.count)")
        print("  frames over 8.33 ms (120 fps budget): \(cold.over(8.33))/\(cold.count)")
        print("")

        let warm = scrollPass(h, forceFullRedraw: false)
        print("  " + warm.line("second pass (layout already warm)"))
        print("  frames over 16.67 ms: \(warm.over(16.67))/\(warm.count)")

        // Sanity bound on the two passes above: `displayIfNeeded` only redraws
        // dirty rects, so force an unconditional full-window redraw per step and
        // check the number stays in the same order of magnitude.
        let forced = scrollPass(h, forceFullRedraw: true)
        print("  " + forced.line("forced full-window redraw per step"))
        print("  frames over 16.67 ms: \(forced.over(16.67))/\(forced.count)")
        print("")
    }

    /// One top-to-bottom pass, 48 pt per step — roughly a brisk two-finger flick
    /// at 60 Hz. Each step is timed from the scroll to the pixels.
    private static func scrollPass(_ h: Harness, forceFullRedraw: Bool) -> Samples {
        h.scrollToTop()
        pump(0.05)
        let clip = h.scrollView.contentView
        let maxY = max(0, (h.scrollView.documentView?.frame.height ?? 0) - clip.bounds.height)
        var frames = Samples()
        var y = clip.bounds.origin.y
        while y < maxY {
            y += 48
            let t0 = CACurrentMediaTime()
            clip.scroll(to: NSPoint(x: 0, y: min(y, maxY)))
            h.scrollView.reflectScrolledClipView(clip)
            if forceFullRedraw {
                h.layout?.textViewportLayoutController.layoutViewport()
                h.window.display()
            } else {
                h.display()
            }
            frames.add((CACurrentMediaTime() - t0) * 1000)
        }
        return frames
    }
}

/// Interesting offsets in the 10k-word document, found by scanning the text so
/// the probes stay put if the generator changes.
struct Spots {
    let paragraph: Int
    let listItem: Int
    let heading: Int
    let headingLineStart: Int
    let headingText: Int
    let emphasisStart: Int
    let emphasisText: Int

    init(in ns: NSString) {
        let middle = ns.length / 2
        let headingRange = ns.range(
            of: "\n## Section", options: [], range: NSRange(location: middle, length: ns.length - middle))
        let h = headingRange.location == NSNotFound ? middle : headingRange.location + 1
        heading = h
        headingLineStart = h
        headingText = h + 3

        let window = NSRange(location: h, length: min(6000, ns.length - h))
        let emphasis = ns.range(of: "**", options: [], range: window)
        emphasisStart = emphasis.location == NSNotFound ? h : emphasis.location
        emphasisText = emphasisStart + 3

        // After the heading: the first long line of plain prose, and the first
        // task-list item (which sits next to a code block or table in the
        // generated document, so typing there is the expensive neighbourhood).
        var para: Int?
        var list: Int?
        var line = ns.lineRange(for: NSRange(location: h, length: 0))
        while NSMaxRange(line) < ns.length, para == nil || list == nil {
            line = ns.lineRange(for: NSRange(location: NSMaxRange(line), length: 0))
            let s = ns.substring(with: line).trimmingCharacters(in: .whitespacesAndNewlines)
            if para == nil, s.count > 200, s.first?.isLetter == true {
                para = line.location + line.length / 2
            }
            if list == nil, s.hasPrefix("- ["), s.count > 40 {
                list = line.location + min(20, line.length - 2)
            }
        }
        paragraph = para ?? h
        listItem = list ?? h
    }

    func describe(_ ns: NSString) -> String {
        func peek(_ i: Int) -> String {
            ns.substring(with: NSRange(location: i, length: min(24, ns.length - i)))
                .debugDescription
        }
        return
            "paragraph=\(paragraph) \(peek(paragraph)), list=\(listItem) \(peek(listItem)), heading=\(heading) \(peek(heading)), emphasis=\(emphasisStart) \(peek(emphasisStart))"
    }
}

func hostDescription() -> String {
    var size = 0
    sysctlbyname("machdep.cpu.brand_string", nil, &size, nil, 0)
    var chars = [CChar](repeating: 0, count: size)
    sysctlbyname("machdep.cpu.brand_string", &chars, &size, nil, 0)
    let cpu = String(cString: chars)
    let os = ProcessInfo.processInfo.operatingSystemVersionString
    let ram = ProcessInfo.processInfo.physicalMemory / 1_073_741_824
    return "\(cpu), \(ram) GB, \(os)"
}
