# Injected native input does not prove the installed journey

Status: open, QA tooling and runtime investigation.

On macOS 27.0, installed Recto 0.1.2 / build 516 from `origin/main` release commit `372ff16dfb475e8ae7b9945ee060c51571afb199` opened the signed-in library and migrated its database successfully. Agent-device snapshots and screenshots showed the controls. Injected clicks on New document and Close outline reported success without changing the UI; text injection reported a mismatch against an empty editor. A retained-runner restart and a held click did not resolve this.

Public Accessibility button actions and text edits did work. They created a separate test draft, persisted and synced Overflow notes, exercised independent note undo/redo and prose history, and transferred selected notes through the system clipboard into prose. Those checks did not mutate the database directly. They do not verify ordinary mouse/keyboard shortcuts.

The current unqueued host reports Accessibility and event-posting access; the queued Pueue probe does not. Requested pointer coordinates matched the actual pointer position. A post-startup process sample showed an idle, responsive main loop. OS logs also contained reentrant SwiftUI layout and gesture-blocking diagnostics during automation. These observations do not establish whether the failure belongs to event injection, gesture state or another runtime path.

Before changing product behavior or system permissions, compare a physical click with injection on the same control and instrument event receipt at the window and control. Keep the actual signed release and display arrangement reproducible: main display 3200×1350 logical points, secondary 1728×1117, library window at x=1602/y=37 with size 1592×1307, AeroSpace running. Do not conclude that missing host access is the cause from a queued-process probe.

The execution evidence and exact resume steps are retained in `~/code/bhekanik/.orchestrate/recto-writing-20261004/handover.md`. A repeated macOS Keychain prompt separately blocks full relaunch until the password is entered locally; it must not be bypassed or confused with the input findings.
