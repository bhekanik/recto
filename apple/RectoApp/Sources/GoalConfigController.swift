import AppKit
import RectoEditor
import SwiftUI

/// The web's goal popover as a floating panel over the status bar's home — the
/// bottom-right of the window, where the widget sits (`align="end"
/// side="top"`). A borderless child panel like the palette's, so it takes the
/// keyboard for its fields, hands it back on close, and closes when it loses
/// key status (a click anywhere else). One panel per settings object; the
/// palette's `set-goal` and the status-bar widget both open it.
@MainActor
final class GoalConfigController {
    static let shared = GoalConfigController(settings: .shared)

    private let settings: StudioSettings
    private var panel: GoalPanel?
    private var closeObserver: NSObjectProtocol?

    init(settings: StudioSettings) {
        self.settings = settings
    }

    var isShown: Bool { panel?.isVisible == true }

    /// Show over `window`, or nowhere when there is none. A second call while
    /// shown is a no-op, like the web's popover. Callers pass their editor's
    /// own window: `NSApp.keyWindow` is nil whenever the app is not frontmost.
    func open(over window: NSWindow?) {
        guard let window, let content = window.contentView, panel == nil else { return }
        let rootView = GoalConfigView(settings: settings, theme: settings.theme, onClose: close)
        let host = NSHostingView(rootView: rootView)
        host.layoutSubtreeIfNeeded()
        let size = host.fittingSize
        // The web anchors to the trigger in the status bar; here the anchor is
        // the bottom edge beside the trailing controls, in the content view's
        // flipped coordinates.
        let bounds = content.bounds
        let anchor = NSRect(
            x: bounds.maxX - size.width - 16, y: 0, width: size.width, height: 1
        )
        let frame = window.convertToScreen(content.convert(anchor, to: nil))
        let panel = GoalPanel(onCancel: close)
        panel.appearance = NSAppearance(named: settings.resolvedAppearance == .dark ? .darkAqua : .aqua)
        panel.isReleasedWhenClosed = false
        panel.setFrame(NSRect(origin: frame.origin, size: size), display: false)
        panel.contentView = host
        self.panel = panel
        window.addChildWindow(panel, ordered: .above)
        panel.makeKeyAndOrderFront(nil)
        closeObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didResignKeyNotification, object: panel, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.close() }
        }
    }

    func close() {
        guard let panel else { return }
        self.panel = nil
        if let closeObserver {
            NotificationCenter.default.removeObserver(closeObserver)
            self.closeObserver = nil
        }
        panel.parent?.removeChildWindow(panel)
        panel.orderOut(nil)
    }
}

/// Borderless and able to take the keyboard — the palette's own panel, made
/// here because the palette's is private. Same shape, same dismissal.
final class GoalPanel: NSPanel {
    private let onCancel: () -> Void

    init(onCancel: @escaping () -> Void) {
        self.onCancel = onCancel
        super.init(
            contentRect: .zero,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        isReleasedWhenClosed = false
        // Moves with its parent only; a drag on the scrim must not detach it.
        isMovable = false
    }

    override var canBecomeKey: Bool { true }

    /// Escape, when a field has not already taken it.
    override func cancelOperation(_ sender: Any?) {
        onCancel()
    }
}

/// The goal popover's body: the web's `goal-popover.tsx` — two targets and
/// three segmented controls, labelled as there, editing the settings directly.
private struct GoalConfigView: View {
    let settings: StudioSettings
    let theme: RectoEditorTheme
    let onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            targetField(
                "Document word goal",
                placeholder: "No goal",
                value: settings.wordGoalTarget,
                onChange: settings.setWordGoalTarget
            )
            segmented(
                "Goal direction",
                options: GoalKind.allCases.map { ($0.label, $0) },
                value: settings.wordGoalKind
            ) { settings.wordGoalKind = $0 }
            targetField(
                "Daily word goal",
                placeholder: "No daily goal",
                value: settings.dailyGoalTarget,
                onChange: settings.setDailyGoalTarget
            )
            segmented(
                "Track",
                options: GoalScope.allCases.map { ($0.label, $0) },
                value: settings.goalScope
            ) { settings.goalScope = $0 }
            segmented(
                "Display",
                options: GoalStyle.allCases.map { ($0.label, $0) },
                value: settings.goalStyle
            ) { settings.goalStyle = $0 }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize()
        .background(Color(nsColor: theme.raised), in: RoundedRectangle(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8).strokeBorder(Color(nsColor: theme.line))
        }
        .onExitCommand(perform: onClose)
    }

    private func targetField(
        _ label: String,
        placeholder: String,
        value: Int,
        onChange: @escaping @MainActor (Double) -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(Color(nsColor: theme.ink3))
            GoalTargetField(
                placeholder: placeholder,
                theme: theme,
                value: value,
                onChange: onChange
            )
        }
    }

    private func segmented<Value: Hashable>(
        _ label: String,
        options: [(String, Value)],
        value: Value,
        onChange: @escaping @MainActor (Value) -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(Color(nsColor: theme.ink3))
            Picker(label, selection: Binding(get: { value }, set: onChange)) {
                ForEach(options, id: \.1) { option in
                    Text(verbatim: option.0).tag(option.1)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
        }
    }
}

/// The web's number input: a target of 0 shows the placeholder, and anything
/// typed is clamped to a non-negative integer on commit (`clampGoalTarget`).
private struct GoalTargetField: View {
    let placeholder: String
    let theme: RectoEditorTheme
    let value: Int
    let onChange: @MainActor (Double) -> Void
    @State private var text = ""
    @State private var isEditing = false

    var body: some View {
        TextField(
            placeholder,
            text: Binding(
                get: {
                    isEditing
                        ? text
                        : value == 0 ? "" : String(value)
                },
                set: { newValue in
                    isEditing = true
                    text = newValue
                }
            )
        )
        .monospacedDigit()
        .textFieldStyle(.plain)
        .padding(.horizontal, 6)
        .frame(height: 26)
        .background(Color(nsColor: theme.canvas), in: RoundedRectangle(cornerRadius: 4))
        .overlay {
            RoundedRectangle(cornerRadius: 4).strokeBorder(Color(nsColor: theme.line))
        }
        .onChange(of: text) { _, typed in
            // The web's number input applies as you type; an empty field is 0,
            // which hides the goal, and anything unparsable leaves it be.
            if typed.isEmpty { onChange(0) } else if let number = Double(typed) { onChange(number) }
        }
        .onSubmit { isEditing = false }
    }
}