import AppKit
import Foundation
import RectoSync
import UniformTypeIdentifiers

/// The native form of `lib/export/file.ts`: an `NSSavePanel` in place of the
/// web's synthetic download, writing what the writer already holds on this Mac.
///
/// `.docx` is the one exception: the app has no second Markdown pipeline and
/// wants the same Word file the browser produces, so the server's
/// `export:docx` action runs the exact renderer the web runs and answers with
/// a short-lived storage URL; the bytes are fetched here and written to the
/// chosen file. The server renders its own copy of the document, so this
/// Mac's edits are pushed first; if they cannot be, the writer is asked
/// before a file that is missing them is made.
@MainActor
enum ExportController {
    /// The action's return shape (`convex/export.ts`), read as far as the
    /// export needs: the fetch URL and the suggested filename.
    private struct DocxExportResult: Decodable, Sendable {
        let url: String
        let filename: String
    }

    /// Export as `.md` — the canonical Markdown string, no BOM.
    static func exportMarkdown(markdown: String, title: String, window: NSWindow?) {
        guard let url = savePanel(named: ExportFile.safeFilename(title), extension: "md", window: window)
        else { return }
        do {
            try Data(markdown.utf8).write(to: url, options: .atomic)
        } catch {
            presentError("Couldn't export Markdown.", error, window: window)
        }
    }

    /// Export as rich text — the self-contained standalone HTML document.
    static func exportHtml(markdown: String, title: String, window: NSWindow?) async {
        guard let url = savePanel(named: ExportFile.safeFilename(title), extension: "html", window: window)
        else { return }
        do {
            let html = try await ExportFile.exportHtml(markdown: markdown, title: title, core: SharedRectoCore.core())
            try Data(html.utf8).write(to: url, options: .atomic)
        } catch {
            presentError("Couldn't export .html.", error, window: window)
        }
    }

    /// Export as `.docx` — the server renders, the app fetches and saves.
    static func exportDocx(cloud: CloudDocumentContext, convexId: String, title: String, window: NSWindow?) async {
        guard await cloud.syncForExport() || confirmExportingLastSyncedVersion() else { return }
        guard let url = savePanel(named: ExportFile.safeFilename(title), extension: "docx", window: window)
        else { return }
        do {
            let result: DocxExportResult = try await cloud.api.action(
                ConvexFunction.exportDocx, args: ["documentId": .string(convexId)])
            guard let source = URL(string: result.url) else {
                throw RemoteCallError(code: nil, message: "The export returned an unreadable URL.")
            }
            // The URL is bearer and expires (`EXPORT_TTL_MS`), so the fetch
            // happens immediately rather than being queued behind a retry.
            let (data, response) = try await URLSession.shared.data(from: source)
            if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                throw RemoteCallError(code: nil, message: "The export file could not be fetched (HTTP \(http.statusCode)).")
            }
            try data.write(to: url, options: .atomic)
        } catch {
            presentError("Couldn't export .docx.", error, window: window)
        }
    }


    private static func confirmExportingLastSyncedVersion() -> Bool {
        let alert = NSAlert()
        alert.messageText = "Some changes haven't synced yet"
        alert.informativeText = "Word export is made on the server, so it would leave out the changes still on this Mac. Export the last synced version anyway?"
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Export Anyway")
        return alert.runModal() == .alertSecondButtonReturn
    }

    /// The web's `copyAsRichText`: one clear, then both representations of the
    /// same item — the rendered HTML and the Markdown source — so a paste
    /// target picks the one it wants.
    static func copyRich(markdown: String, pasteboard: NSPasteboard, window: NSWindow?) async {
        do {
            let html = try await SharedRectoCore.core().htmlFromMarkdown(markdown)
            pasteboard.clearContents()
            pasteboard.setString(html, forType: .html)
            pasteboard.setString(markdown, forType: .string)
        } catch {
            presentError("Couldn't copy as rich text — use Copy as Markdown instead.", error, window: window)
        }
    }

    // MARK: - Save panel

    private static func savePanel(named name: String, extension ext: String, window: NSWindow?) -> URL? {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "\(name).\(ext)"
        if let type = UTType(filenameExtension: ext) {
            panel.allowedContentTypes = [type]
        }
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        return url
    }

    /// Errors reach the writer the way the web's toasts do, as one line saying
    /// what failed — the reasons (core not loaded, server refusal, HTTP) all
    /// read better as the error's own description.
    static func presentError(_ headline: String, _ error: any Error, window: NSWindow?) {
        let alert = NSAlert()
        alert.messageText = headline
        alert.informativeText = error.localizedDescription
        alert.runModal()
    }
}