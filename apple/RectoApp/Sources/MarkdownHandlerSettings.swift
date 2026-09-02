import AppKit
import Foundation
import Observation
import UniformTypeIdentifiers

@MainActor
protocol MarkdownHandlerWorkspace {
    func defaultApplicationURL(toOpen contentType: UTType) -> URL?
    func setDefaultApplication(at applicationURL: URL, toOpen contentType: UTType) async throws
}

struct LaunchServicesWorkspace: MarkdownHandlerWorkspace {
    func defaultApplicationURL(toOpen contentType: UTType) -> URL? {
        NSWorkspace.shared.urlForApplication(toOpen: contentType)
    }

    func setDefaultApplication(at applicationURL: URL, toOpen contentType: UTType) async throws {
        try await NSWorkspace.shared.setDefaultApplication(at: applicationURL, toOpen: contentType)
    }
}

@MainActor
@Observable
final class MarkdownHandlerSettings {
    private(set) var defaultApplicationName: String?
    private(set) var isRectoDefault = false
    private(set) var isUpdating = false
    private(set) var errorMessage: String?

    private let workspace: any MarkdownHandlerWorkspace
    private let notificationCenter: NotificationCenter
    private let applicationURL: URL
    private var activationObserver: (any NSObjectProtocol)?

    init(
        workspace: any MarkdownHandlerWorkspace = LaunchServicesWorkspace(),
        notificationCenter: NotificationCenter = .default,
        applicationURL: URL = Bundle.main.bundleURL
    ) {
        self.workspace = workspace
        self.notificationCenter = notificationCenter
        self.applicationURL = applicationURL
        refresh()
        // Finder > Get Info can change the binding while Recto is in the background.
        activationObserver = notificationCenter.addObserver(
            forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh() }
        }
    }

    isolated deinit {
        if let activationObserver {
            notificationCenter.removeObserver(activationObserver)
        }
    }

    func refresh() {
        let defaultURL = workspace.defaultApplicationURL(toOpen: RectoDocument.markdownContentType)
        defaultApplicationName = defaultURL.map(Self.applicationName(at:))
        // Launch Services binds by bundle identifier and may hand back any installed copy,
        // so a path comparison never matches on a Mac with more than one Recto.
        isRectoDefault = defaultURL.flatMap(Bundle.init(url:))?.bundleIdentifier
            == Bundle.main.bundleIdentifier
    }

    func makeRectoDefault() async {
        guard !isUpdating else { return }
        isUpdating = true
        defer { isUpdating = false }
        errorMessage = nil
        do {
            try await workspace.setDefaultApplication(
                at: applicationURL, toOpen: RectoDocument.markdownContentType)
        } catch {
            errorMessage = MarkdownHandlerError.changeRejected.localizedDescription
        }
        refresh()
    }

    private static func applicationName(at url: URL) -> String {
        let bundle = Bundle(url: url)
        return bundle?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
            ?? bundle?.object(forInfoDictionaryKey: "CFBundleName") as? String
            ?? url.deletingPathExtension().lastPathComponent
    }
}

enum MarkdownHandlerError: LocalizedError {
    case changeRejected

    var errorDescription: String? {
        switch self {
        case .changeRejected:
            "macOS refused the change. "
                + "Set it in Finder instead: select a Markdown file, choose File > Get Info, "
                + "pick Recto under Open With, then click Change All."
        }
    }
}
