import RectoEditor
import RectoHistory
import RectoSync
import SwiftUI

/// `components/history/history-panel.tsx` as a trailing panel: the undo tree
/// (jump anywhere, compare any two) and the named versions (tag, restore,
/// compare, rename, delete), with a preview or a diff underneath.
struct HistoryPanel: View {
    let history: DocumentHistoryModel
    let settings: StudioSettings
    let theme: RectoEditorTheme
    @Binding var view: HistoryView?

    private static let width: CGFloat = 360

    var body: some View {
        VStack(spacing: 0) {
            header
            Color(nsColor: theme.line).frame(height: 1)
            if view == .versions { versionsList } else { treeList }
            footer
        }
        .frame(width: Self.width)
        .background(Color(nsColor: theme.sheet))
        .overlay(alignment: .leading) { Color(nsColor: theme.line).frame(width: 1) }
        .alert("History", isPresented: Binding(
            get: { history.errorMessage != nil }, set: { if !$0 { history.errorMessage = nil } }
        )) {} message: {
            Text(history.errorMessage ?? "")
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("Document history")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color(nsColor: theme.ink2))
            Spacer()
            Picker("View", selection: Binding(get: { view ?? .tree }, set: { view = $0 })) {
                Label("Tree", systemImage: "arrow.triangle.branch").tag(HistoryView.tree)
                Label("Versions", systemImage: "clock.arrow.circlepath").tag(HistoryView.versions)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .controlSize(.small)
            .fixedSize()
            Button { view = nil } label: { Image(systemName: "xmark") }
                .buttonStyle(.plain)
                .foregroundStyle(Color(nsColor: theme.ink3))
                .help("Close history")
                .accessibilityLabel("Close history")
        }
        .padding(.horizontal, 12)
        .frame(height: 40)
    }

    private var treeList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(history.rows) { row in
                    treeRow(row)
                }
            }
            .padding(.vertical, 4)
        }
    }

    private func treeRow(_ row: DocumentHistoryModel.Row) -> some View {
        let node = row.node
        let isCurrent = node.nodeId == history.currentNodeId
        let selected = history.compareSelection.contains(node.nodeId)
        return HStack(spacing: 6) {
            Button {
                Task { await history.navigate(to: node.nodeId) }
            } label: {
                HStack(spacing: 8) {
                    Circle()
                        .strokeBorder(Color(nsColor: isCurrent ? theme.accent : theme.line), lineWidth: 1)
                        .background(Circle().fill(isCurrent ? Color(nsColor: theme.accent) : .clear))
                        .frame(width: 8, height: 8)
                    Text(nodeLabel(patch: node.patch, parentNodeId: node.parentNodeId, origin: node.origin))
                        .lineLimit(1)
                        .foregroundStyle(Color(nsColor: isCurrent ? theme.ink : theme.ink2))
                    ForEach(history.versions(at: node.nodeId)) { version in
                        Text(version.label)
                            .font(.system(size: 10))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Color(nsColor: theme.accent.withAlphaComponent(0.15)), in: RoundedRectangle(cornerRadius: 3))
                            .foregroundStyle(Color(nsColor: theme.accent2))
                    }
                    Spacer(minLength: 4)
                    Text(Self.time(node.createdAt))
                        .foregroundStyle(Color(nsColor: theme.ink3))
                }
                .padding(.leading, CGFloat(row.depth) * 16 + 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { inside in Task { await history.showPreview(of: inside ? node.nodeId : nil) } }
            Button {
                Task { await history.toggleCompare(node.nodeId) }
            } label: {
                Text(selected ? "✓" : "⇄").font(.system(size: 10))
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color(nsColor: selected ? theme.accent : theme.ink3))
            .help("Select for compare")
            .accessibilityLabel("Select for compare")
        }
        .font(.system(size: 12))
        .padding(.horizontal, 8)
        .frame(height: 26)
    }

    private var versionsList: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button("Tag current version") {
                if let label = TextPrompt.ask("Name this version", defaultValue: "Version \(Date().formatted(date: .abbreviated, time: .shortened))") {
                    Task { await history.tagCurrent(label: label.isEmpty ? "Version" : label) }
                }
            }
            .controlSize(.small)
            Text("Restore is additive — it never erases later edits.")
                .font(.system(size: 11))
                .foregroundStyle(Color(nsColor: theme.ink3))
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    ForEach(history.versions) { version in
                        versionRow(version)
                    }
                    if history.versions.isEmpty {
                        Text("No versions yet. Tag one to keep a durable point.")
                            .font(.system(size: 12))
                            .foregroundStyle(Color(nsColor: theme.ink3))
                    }
                }
            }
        }
        .padding(12)
    }

    private func versionRow(_ version: RemoteVersion) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(version.label).lineLimit(1).foregroundStyle(Color(nsColor: theme.ink))
                Text(version.kind.rawValue.uppercased())
                    .font(.system(size: 9))
                    .foregroundStyle(Color(nsColor: version.kind == .manual ? theme.ink2 : theme.ink3))
                Spacer()
                Text(Self.time(version.createdAt)).foregroundStyle(Color(nsColor: theme.ink3))
            }
            HStack(spacing: 10) {
                Button("Restore") { Task { await history.restore(version.nodeId) } }
                Button(history.compareSelection.contains(version.nodeId) ? "Comparing" : "Compare") {
                    Task { await history.toggleCompare(version.nodeId) }
                }
                if version.kind == .manual {
                    Button("Rename") {
                        if let label = TextPrompt.ask("Rename version", defaultValue: version.label), !label.isEmpty {
                            Task { await history.rename(version, to: label) }
                        }
                    }
                }
                Button("Delete") { Task { await history.remove(version) } }
            }
            .buttonStyle(.link)
            .font(.system(size: 11))
        }
        .font(.system(size: 12))
        .padding(8)
        .background(Color(nsColor: theme.raised), in: RoundedRectangle(cornerRadius: 6))
        .onHover { inside in Task { await history.showPreview(of: inside ? version.nodeId : nil) } }
    }

    @ViewBuilder
    private var footer: some View {
        if let texts = history.compareTexts {
            VStack(alignment: .leading, spacing: 6) {
                Color(nsColor: theme.line).frame(height: 1)
                DiffRunsToggle(settings: settings, theme: theme).padding(.horizontal, 12)
                ScrollView {
                    DiffRunsView(
                        runs: diffRuns(texts.a, texts.b, granularity: settings.diffGranularity),
                        layout: settings.diffLayout, theme: theme)
                        .padding(12)
                }
                .frame(maxHeight: 260)
            }
        } else if let preview = history.preview {
            VStack(alignment: .leading, spacing: 0) {
                Color(nsColor: theme.line).frame(height: 1)
                ScrollView {
                    Text(preview.isEmpty ? "(empty)" : String(preview.prefix(500)) + (preview.count > 500 ? "…" : ""))
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Color(nsColor: theme.ink2))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                }
                .frame(maxHeight: 180)
            }
        }
    }

    /// The web's `formatTime`: the time today, the date otherwise.
    static func time(_ milliseconds: Double) -> String {
        let date = Date(timeIntervalSince1970: milliseconds / 1000)
        return Calendar.current.isDateInToday(date)
            ? date.formatted(date: .omitted, time: .shortened)
            : date.formatted(.dateTime.month(.abbreviated).day())
    }
}
