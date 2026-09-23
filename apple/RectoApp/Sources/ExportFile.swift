import Foundation
import RectoCoreJS
import RectoEditor

/// `lib/export/filename.ts` and the standalone wrapper of
/// `lib/export/html.ts`, ported so a `.html` file exported from the Mac opens
/// like one exported from the browser: same header, same `<title>`, same
/// styles.
enum ExportFile {
    /// `safeFilename`: strip illegal filename characters, collapse whitespace,
    /// cap length, fall back to "untitled". The length cap counts UTF-16
    /// units, like the web's `slice`, so the two platforms agree on filenames
    /// for titles with astral characters.
    static func safeFilename(_ title: String) -> String {
        var cleaned = String()
        for character in title {
            cleaned.append("\\/:*?\"<>|".contains(character) ? "-" : character)
        }
        cleaned = cleaned.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        let trimmed = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "untitled" }
        let ns = trimmed as NSString
        return ns.length > 120 ? ns.substring(to: 120) : trimmed
    }

    /// `generateExportHtml`, with the rendered body supplied by the JS core
    /// (`htmlFromMarkdown`). The web's export pipeline absolutizes URLs
    /// against its own origin; the native app has none to offer, so it runs the
    /// core's render and keeps the wrapper — the document header, title and
    /// styles are what "exported from Recto" looks like.
    static func exportHtml(markdown: String, title: String, core: RectoCore) async throws -> String {
        let body = try await core.htmlFromMarkdown(markdown)
        return generateExportHtml(markdown: markdown, title: title, bodyHtml: body)
    }

    /// The wrapper and the frontmatter document header, byte-for-byte with the
    /// web apart from the body renderer.
    static func generateExportHtml(markdown: String, title: String, bodyHtml: String) -> String {
        let meta = Frontmatter.parse(markdown)
        let header = renderExportHeader(title: meta?.title ?? "", subtitle: meta?.subtitle ?? "")
        let docTitle = nonEmpty(meta?.title) ?? title
        let body = header.isEmpty ? bodyHtml : "\(header)\n\(bodyHtml)"
        return wrapSelfContainedHtml(body, title: docTitle)
    }

    /// The web's `EXPORT_STYLE`, unchanged.
    private static let style = """
    :root { color-scheme: light; }
    body {
      font-family: "Source Serif 4", Georgia, "Times New Roman", serif;
      font-size: 17px; line-height: 1.65; color: #1a1a1a;
      max-width: 42rem; margin: 2.5rem auto; padding: 0 1.25rem;
    }
    h1,h2,h3,h4,h5,h6 { line-height: 1.25; margin: 1.6em 0 0.5em; font-weight: 600; }
    h1 { font-size: 1.8rem; } h2 { font-size: 1.5rem; } h3 { font-size: 1.3rem; }
    p, ul, ol, blockquote, pre, table { margin: 0 0 1em; }
    a { color: #0b5; text-decoration: underline; }
    code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.9em;
      background: #f3f3f3; padding: 0.1em 0.35em; border-radius: 3px; }
    pre { background: #f6f6f6; padding: 1rem; border-radius: 6px; overflow-x: auto; }
    pre code { background: none; padding: 0; }
    blockquote { border-left: 3px solid #ccc; padding-left: 1rem; color: #555; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 0.4em 0.6em; }
    th { background: #f3f3f3; }
    img { max-width: 100%; }
    hr { border: none; border-top: 1px solid #ddd; margin: 2rem 0; }
    .recto-subtitle { font-size: 1.2rem; color: #555; margin: -0.4em 0 0; }
    .recto-doc-header h1 { margin-top: 0; }
    .recto-doc-header hr { margin: 1.2rem 0 2rem; }
    """

    /// The web's `wrapSelfContainedHtml`.
    private static func wrapSelfContainedHtml(_ body: String, title: String) -> String {
        """
        <!doctype html>
        <html lang="en">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>\(escapeHtml(title))</title>
        <style>\(style)</style>
        </head>
        <body>
        \(body)
        </body>
        </html>
        """
    }

    /// The web's `renderExportHeader`: frontmatter is metadata, so it is
    /// pulled out as a header rather than left to render as text.
    private static func renderExportHeader(title: String, subtitle: String) -> String {
        let title = nonEmpty(title) ?? ""
        let subtitle = nonEmpty(subtitle) ?? ""
        if title.isEmpty, subtitle.isEmpty { return "" }
        var parts = ["<header class=\"recto-doc-header\">"]
        if !title.isEmpty { parts.append("<h1>\(escapeHtml(title))</h1>") }
        if !subtitle.isEmpty { parts.append("<p class=\"recto-subtitle\">\(escapeHtml(subtitle))</p>") }
        parts.append("<hr>")
        parts.append("</header>")
        return parts.joined(separator: "\n")
    }

    /// The web's `escapeHtml`: `&`, `<`, `>` — enough for the header and title.
    private static func escapeHtml(_ text: String) -> String {
        text
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }
}