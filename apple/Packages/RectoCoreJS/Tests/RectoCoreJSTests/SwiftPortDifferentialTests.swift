import Foundation
import Testing

@testable import RectoCoreJS

@Suite("Swift ports, generated differential")
struct SwiftPortDifferentialTests {
    @Test("384 seeded documents agree with the JS core")
    func generatedDocumentsAgreeWithCore() async throws {
        let corpus = try Fixtures.load(Corpus.self, "markdown-corpus.json")
        let documents = MarkdownDifferentialGenerator.documents(unicodeCases: corpus.unicode)
        let core = try Fixtures.shared()

        #expect(documents.count == MarkdownDifferentialGenerator.documentCount)
        #expect(documents.count >= 200)
        #expect(
            documents.filter(\.isMutated).count
                == MarkdownDifferentialGenerator.mutatedDocumentCount)
        #expect(
            documents.allSatisfy {
                $0.markdown.count <= MarkdownDifferentialGenerator.maximumDocumentCharacters
            })

        for (index, document) in documents.enumerated() {
            let swiftWords = WordCount.count(document.markdown)
            let jsWords = try await core.countWords(document.markdown)
            #expect(
                swiftWords == jsWords,
                Comment(rawValue: failure(
                    index: index, document: document,
                    swift: "\(swiftWords)", js: "\(jsWords)", contract: "WordCount")))

            let swiftOutline = Outline.parse(document.markdown)
            let jsOutline = try await core.parseOutline(document.markdown)
            #expect(
                outlinesMatch(swiftOutline, jsOutline),
                Comment(rawValue: failure(
                    index: index, document: document,
                    swift: describeOutline(swiftOutline), js: describeOutline(jsOutline),
                    contract: "Outline")))
        }
    }

    private func outlinesMatch(_ first: [OutlineHeading], _ second: [OutlineHeading]) -> Bool {
        first.count == second.count && zip(first, second).allSatisfy { left, right in
            left.depth == right.depth && left.offset == right.offset && left.index == right.index
                && sameCodeUnits(left.text, right.text)
        }
    }

    private func describeOutline(_ outline: [OutlineHeading]) -> String {
        outline.map {
            "(depth: \($0.depth), text: \(describe($0.text)), offset: \($0.offset), index: \($0.index))"
        }.joined(separator: ", ")
    }

    private func failure(
        index: Int, document: DifferentialDocument, swift: String, js: String, contract: String
    ) -> String {
        """
        \(contract) mismatch at document \(index) (\(document.name)), seed \(MarkdownDifferentialGenerator.seed)
        document: \(document.markdown.debugDescription)
        Swift: \(swift)
        JS: \(js)
        """
    }
}
