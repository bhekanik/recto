//
//  DocumentHeaderView.swift
//  RectoEditor
//

import SwiftUI

/// The frontmatter, rendered as the document's header instead of as YAML.
///
/// Design §4.2: title, subtitle and the newsletter fields sit above the sheet's
/// first hairline in rich and preview; in raw the block is ordinary source and
/// this does not appear. The editor hides the YAML from the body, so without
/// this the title would simply vanish — worse than showing the source.
///
/// Only the four named fields render. Everything else in the block is metadata
/// for the app (tags, dates, ids), not something the reader is writing.
struct DocumentHeaderView: View {
    let frontmatter: Frontmatter
    let styler: MarkdownStyler

    /// Whether there is anything to draw. A block of nothing but tags and dates
    /// renders no header at all rather than an empty band.
    static func hasVisibleFields(_ frontmatter: Frontmatter) -> Bool {
        frontmatter.title != nil || frontmatter.subtitle != nil
            || frontmatter.subject != nil || frontmatter.preview != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let title = frontmatter.title {
                Text(title)
                    .font(.custom(styler.typography.family, size: titleSize).weight(.bold))
                    .foregroundStyle(Color(nsColor: styler.theme.ink))
                    .accessibilityIdentifier(Self.titleIdentifier)
            }
            if let subtitle = frontmatter.subtitle {
                Text(subtitle)
                    .font(.custom(styler.typography.family, size: subtitleSize))
                    .foregroundStyle(Color(nsColor: styler.theme.ink2))
                    .accessibilityIdentifier(Self.subtitleIdentifier)
            }
            if frontmatter.subject != nil || frontmatter.preview != nil {
                newsletterFields
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 16)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color(nsColor: styler.theme.line))
                .frame(height: 1)
        }
    }

    /// Subject and preheader are what the reader is composing for an inbox, so
    /// they are labelled — unlike the title, they are not self-evident.
    private var newsletterFields: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let subject = frontmatter.subject {
                labelled("Subject", subject, identifier: Self.subjectIdentifier)
            }
            if let preview = frontmatter.preview {
                labelled("Preview", preview, identifier: Self.previewIdentifier)
            }
        }
        .padding(.top, 6)
    }

    private func labelled(_ label: String, _ value: String, identifier: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Color(nsColor: styler.theme.ink3))
            Text(value)
                .font(.custom(styler.typography.family, size: metaSize))
                .foregroundStyle(Color(nsColor: styler.theme.ink2))
                .accessibilityIdentifier(identifier)
        }
    }

    private var titleSize: CGFloat {
        styler.typography.resolvedSize * styler.typography.headingMultipliers[0]
    }
    private var subtitleSize: CGFloat { styler.typography.resolvedSize * 1.08 }
    private var metaSize: CGFloat { styler.typography.resolvedSize * 0.85 }

    // Stable identifiers so a window-backed test can find the real rendered
    // views rather than re-deriving what they should say.
    static let titleIdentifier = "recto.header.title"
    static let subtitleIdentifier = "recto.header.subtitle"
    static let subjectIdentifier = "recto.header.subject"
    static let previewIdentifier = "recto.header.preview"
}
