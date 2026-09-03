//
//  VimStatusView.swift
//  RectoEditor
//

import RectoVim
import SwiftUI

/// Vim's mode line, as one inline cluster for the app's status bar.
///
/// Renders `RectoVimController.status` the way CodeMirror-vim's panel does on
/// the web: the mode label (`-- INSERT --`, `-- VISUAL LINE --`, nothing in
/// normal mode), or the open `:`/`/` line while one is being typed; then the
/// last one-shot message; and the keys of a half-typed command (`3d`) on the
/// trailing edge, where vim shows them. Empty when there is nothing to say.
public struct VimStatusView: View {
    private let status: VimStatus?
    private let theme: RectoEditorTheme

    public init(status: VimStatus?, theme: RectoEditorTheme = .twilight) {
        self.status = status
        self.theme = theme
    }

    public var body: some View {
        if let status {
            HStack(spacing: 12) {
                if let prompt = status.prompt {
                    Text(prompt)
                        .foregroundStyle(Color(nsColor: theme.ink))
                } else if !status.label.isEmpty {
                    Text(status.label)
                        .fontWeight(.semibold)
                        .foregroundStyle(Color(nsColor: theme.ink))
                }
                if let message = status.message, !message.isEmpty {
                    Text(message)
                        .foregroundStyle(Color(nsColor: theme.ink3))
                        .lineLimit(1)
                }
                if !status.pending.isEmpty {
                    Text(status.pending)
                        .foregroundStyle(Color(nsColor: theme.ink3))
                }
            }
            .font(.system(size: 11, design: .monospaced))
            .accessibilityElement(children: .combine)
            .accessibilityLabel(accessibilityText(for: status))
        }
    }

    private func accessibilityText(for status: VimStatus) -> String {
        var parts: [String] = ["Vim, \(status.mode) mode"]
        if let prompt = status.prompt { parts.append("command line \(prompt)") }
        if let message = status.message, !message.isEmpty { parts.append(message) }
        if !status.pending.isEmpty { parts.append("pending \(status.pending)") }
        return parts.joined(separator: ", ")
    }
}
