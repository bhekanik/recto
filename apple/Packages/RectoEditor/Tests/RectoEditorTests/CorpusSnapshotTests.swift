//
//  CorpusSnapshotTests.swift
//  RectoEditorTests
//
//  The 24 canonical dialect cases (`lib/markdown/corpus/cases.ts`, copied by
//  `Tools/make-corpus.ts`) rendered in rich and raw. Two things are asserted:
//  the text storage still holds the input byte for byte, and what the reader
//  sees matches a checked-in expectation.
//
//  Regenerate the expectations after a deliberate rendering change:
//
//      RECTO_UPDATE_SNAPSHOTS=1 swift test --filter Corpus
//
//  and read the diff. That diff IS the review of the rendering rules.
//

import AppKit
import Foundation
import MarkdownEngine
import Testing
@testable import RectoEditor

@MainActor
@Suite("Corpus snapshots")
struct CorpusSnapshotTests {

    static let cases: [(name: String, markdown: String)] = {
        guard let dir = Bundle.module.url(forResource: "Corpus", withExtension: nil),
              let files = try? FileManager.default.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: nil)
        else { return [] }
        return files
            .filter { $0.pathExtension == "md" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
            .compactMap { url in
                (try? String(contentsOf: url, encoding: .utf8))
                    .map { (url.deletingPathExtension().lastPathComponent, $0) }
            }
    }()

    @Test("the corpus files are present")
    func corpusIsPresent() {
        #expect(Self.cases.count == 24)
    }

    @Test("the styled storage string is byte-identical to the source",
          arguments: Self.cases)
    func storageIsByteIdentical(testCase: (name: String, markdown: String)) {
        for presentation in [Presentation.rich, .raw, .preview] {
            let styled = render(testCase.markdown, presentation: presentation)
            #expect(styled.string == testCase.markdown,
                    "\(testCase.name) in \(presentation.rawValue) changed the string")
        }
    }

    @Test("preview renders exactly like rich with no caret anywhere",
          arguments: Self.cases)
    func previewMatchesRich(testCase: (name: String, markdown: String)) {
        // The design says preview IS rich with editing off and every marker
        // hidden. It is easy to make them diverge by accident — one engine flag
        // that reads as an editing switch also gates the drawn list markers —
        // so hold them together.
        #expect(ReaderView.dump(render(testCase.markdown, presentation: .preview))
            == ReaderView.dump(render(testCase.markdown, presentation: .rich)),
                "\(testCase.name): preview diverged from rich")
    }

    @Test("what the reader sees matches the checked-in expectation",
          arguments: Self.cases)
    func readerViewMatchesSnapshot(testCase: (name: String, markdown: String)) throws {
        var sections: [String] = []
        for presentation in [Presentation.rich, .raw, .preview] {
            let styled = render(testCase.markdown, presentation: presentation)
            sections.append("## \(presentation.rawValue)\n\(ReaderView.dump(styled))")
        }
        let actual = "# \(testCase.name)\n\n" + sections.joined(separator: "\n\n") + "\n"

        let file = "\(testCase.name).txt"
        if ProcessInfo.processInfo.environment["RECTO_UPDATE_SNAPSHOTS"] == "1" {
            try write(actual, to: file)
            return
        }
        let expected = try #require(
            Bundle.module.url(forResource: "Snapshots/\(testCase.name)", withExtension: "txt")
                .flatMap { try? String(contentsOf: $0, encoding: .utf8) },
            "no snapshot for \(testCase.name); run with RECTO_UPDATE_SNAPSHOTS=1"
        )
        #expect(actual == expected, "\(testCase.name): rendering changed")
    }

    // MARK: - Helpers

    /// The document as the styler renders it with no caret anywhere, which is
    /// what the reader sees when they are not editing that spot — the state the
    /// snapshots capture.
    private func render(_ markdown: String, presentation: Presentation) -> NSAttributedString {
        // The engine resolves table colours against the app's appearance, and
        // `NSApp` is nil in a test process until something touches it.
        _ = NSApplication.shared
        let styler = MarkdownStyler(presentation: presentation, theme: .twilight)
        return MarkdownRendering.attributedString(
            for: markdown,
            fontName: styler.typography.family,
            fontSize: styler.typography.resolvedSize,
            configuration: styler.engineConfiguration()
        )
    }

    /// Snapshots are written back into the source tree, not the test bundle —
    /// the bundle copy is discarded on the next build.
    private func write(_ contents: String, to file: String) throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("Snapshots")
            .appendingPathComponent(file)
        try FileManager.default.createDirectory(
            at: source.deletingLastPathComponent(), withIntermediateDirectories: true)
        try contents.write(to: source, atomically: true, encoding: .utf8)
    }
}
