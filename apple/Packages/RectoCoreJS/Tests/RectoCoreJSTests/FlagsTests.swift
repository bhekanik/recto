import Foundation
import Testing

@testable import RectoCoreJS

/// `flags.json`: `lib/markdown/flags.ts`'s answers, which the JS core must
/// reproduce and the Swift edits must match.
private struct FlagsFixture: Decodable {
    struct Edit: Decodable {
        let renamed: String
        let removed: String
    }
    struct FindCase: Decodable {
        let name: String
        let markdown: String
        let flags: [WritingFlag]
        let edits: [Edit]
    }
    struct InsertCase: Decodable {
        let name: String
        let markdown: String
        let at: Int
        let note: String
        let inserted: String
    }
    let find: [FindCase]
    let insert: [InsertCase]
}

@Suite("Writing flags")
struct FlagsTests {
    private let fixture: FlagsFixture

    init() throws {
        fixture = try Fixtures.load(FlagsFixture.self, "flags.json")
    }

    @Test("the JS core finds what lib/ finds")
    func coreFinds() async throws {
        let core = try Fixtures.shared()
        for testCase in fixture.find {
            #expect(try await core.findFlags(testCase.markdown) == testCase.flags, "\(testCase.name)")
        }
    }

    @Test("a new flag inserts the web's text, guard and all")
    func insertion() {
        for testCase in fixture.insert {
            #expect(
                Flags.insertion(in: testCase.markdown, at: testCase.at, note: testCase.note) == testCase.inserted,
                "\(testCase.name)")
        }
    }

    @Test("renaming and resolving each flag match the web")
    func edits() {
        for testCase in fixture.find {
            for (flag, edit) in zip(testCase.flags, testCase.edits) {
                #expect(Flags.settingNote("renamed", of: flag, in: testCase.markdown) == edit.renamed, "\(testCase.name)")
                #expect(Flags.removing(flag, from: testCase.markdown) == edit.removed, "\(testCase.name)")
            }
        }
    }
}
