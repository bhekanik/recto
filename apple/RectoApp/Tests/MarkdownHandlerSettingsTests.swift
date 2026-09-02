import AppKit
import Foundation
import Testing
import UniformTypeIdentifiers

@testable import Recto

@MainActor
private final class FakeWorkspace: MarkdownHandlerWorkspace {
    struct Failure: Error {}

    var defaultURL: URL?
    var shouldFail = false
    private(set) var requests: [(application: URL, contentType: UTType)] = []

    init(defaultURL: URL?) {
        self.defaultURL = defaultURL
    }

    func defaultApplicationURL(toOpen contentType: UTType) -> URL? {
        defaultURL
    }

    func setDefaultApplication(at applicationURL: URL, toOpen contentType: UTType) async throws {
        requests.append((applicationURL, contentType))
        if shouldFail { throw Failure() }
        defaultURL = applicationURL
    }
}

@MainActor
@Suite("markdown handler settings")
struct MarkdownHandlerSettingsTests {
    // Bundle(url:) only reads an identifier from a real bundle, so the fakes point at installed apps.
    private let otherApp = URL(fileURLWithPath: "/System/Applications/TextEdit.app")

    @Test("reports the other app that currently opens Markdown")
    func reportsOtherDefault() {
        let workspace = FakeWorkspace(defaultURL: otherApp)
        let settings = MarkdownHandlerSettings(
            workspace: workspace, notificationCenter: NotificationCenter())

        #expect(settings.isRectoDefault == false)
        #expect(settings.defaultApplicationName == "TextEdit")
        #expect(settings.errorMessage == nil)
    }

    @Test("asks Launch Services to bind the Markdown type to this bundle")
    func makesRectoDefault() async {
        let workspace = FakeWorkspace(defaultURL: otherApp)
        let settings = MarkdownHandlerSettings(
            workspace: workspace, notificationCenter: NotificationCenter())

        await settings.makeRectoDefault()

        #expect(workspace.requests.count == 1)
        #expect(workspace.requests.first?.application == Bundle.main.bundleURL)
        #expect(workspace.requests.first?.contentType == UTType("net.daringfireball.markdown"))
        #expect(settings.isRectoDefault)
        #expect(settings.defaultApplicationName == "Recto")
        #expect(settings.errorMessage == nil)
    }

    @Test("surfaces a rejected change without altering the reported default")
    func surfacesRejection() async {
        let workspace = FakeWorkspace(defaultURL: otherApp)
        workspace.shouldFail = true
        let settings = MarkdownHandlerSettings(
            workspace: workspace, notificationCenter: NotificationCenter())

        await settings.makeRectoDefault()

        #expect(settings.isRectoDefault == false)
        #expect(settings.defaultApplicationName == "TextEdit")
        #expect(settings.errorMessage?.contains("Get Info") == true)
        #expect(settings.isUpdating == false)
    }

    @Test("treats another copy of Recto as the default")
    func matchesByBundleIdentifier() throws {
        let copy = FileManager.default.temporaryDirectory
            .appending(path: "recto-copy-\(UUID().uuidString)/Recto.app")
        try FileManager.default.createDirectory(
            at: copy.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: Bundle.main.bundleURL, to: copy)
        defer { try? FileManager.default.removeItem(at: copy.deletingLastPathComponent()) }
        let workspace = FakeWorkspace(defaultURL: copy)

        let settings = MarkdownHandlerSettings(
            workspace: workspace, notificationCenter: NotificationCenter())

        #expect(settings.isRectoDefault)
    }

    @Test("re-reads the default when the app becomes active")
    func refreshesOnActivation() {
        let center = NotificationCenter()
        let workspace = FakeWorkspace(defaultURL: otherApp)
        let settings = MarkdownHandlerSettings(workspace: workspace, notificationCenter: center)
        workspace.defaultURL = Bundle.main.bundleURL

        center.post(name: NSApplication.didBecomeActiveNotification, object: nil)

        #expect(settings.isRectoDefault)
    }

    @Test("the bundle claims Markdown as a Default-rank editor")
    func bundleDeclaresMarkdown() throws {
        let info = try #require(Bundle.main.infoDictionary)
        let documentTypes = try #require(info["CFBundleDocumentTypes"] as? [[String: Any]])
        let markdownType = try #require(documentTypes.first {
            ($0["LSItemContentTypes"] as? [String])?.contains("net.daringfireball.markdown") == true
        })
        #expect(markdownType["LSHandlerRank"] as? String == "Default")
        #expect(markdownType["CFBundleTypeRole"] as? String == "Editor")

        let imported = try #require(info["UTImportedTypeDeclarations"] as? [[String: Any]])
        let declaration = try #require(imported.first {
            $0["UTTypeIdentifier"] as? String == "net.daringfireball.markdown"
        })
        let tags = try #require(declaration["UTTypeTagSpecification"] as? [String: Any])
        let extensions = try #require(tags["public.filename-extension"] as? [String])
        #expect(Set(extensions) == ["md", "markdown"])
    }
}
