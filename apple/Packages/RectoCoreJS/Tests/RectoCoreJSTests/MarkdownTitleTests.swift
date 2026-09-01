import Testing

@testable import RectoCoreJS

@Suite("Markdown title")
struct MarkdownTitleTests {
    @Test("matches the web title corpus")
    func matchesWebCorpus() throws {
        let fixture = try Fixtures.load(TitleFixture.self, "title.json")
        for testCase in fixture.cases {
            #expect(
                MarkdownTitle.derive(testCase.markdown) == testCase.title,
                "\(testCase.name): \(testCase.markdown.debugDescription)")
        }
    }
}
