# Injected native input does not prove the installed journey

Status: open for injected clicks and keyboard input. Held Overflow drag passes on signed 0.1.3.

On macOS 27.0, installed Recto 0.1.2 / build 516 from `origin/main` release commit `372ff16dfb475e8ae7b9945ee060c51571afb199` opened the signed-in library and migrated its database successfully. Agent-device snapshots and screenshots showed the controls. Injected clicks on New document and Close outline reported success without changing the UI; text injection reported a mismatch against an empty editor. A retained-runner restart and a held click did not resolve this.

Public Accessibility button actions and text edits did work. They created a separate test draft, persisted and synced Overflow notes, exercised independent note undo/redo and prose history, and transferred selected notes through the system clipboard into prose. Those checks did not mutate the database directly. They do not verify ordinary mouse/keyboard shortcuts.

The current unqueued host reports Accessibility and event-posting access; the queued Pueue probe does not. Requested pointer coordinates matched the actual pointer position. A post-startup process sample showed an idle, responsive main loop. OS logs also contained reentrant SwiftUI layout and gesture-blocking diagnostics during automation. These observations do not establish whether the failure belongs to event injection, gesture state or another runtime path.

Before changing product behavior or system permissions, compare a physical click with injection on the same control and instrument event receipt at the window and control. Keep the actual signed release and display arrangement reproducible: main display 3200×1350 logical points, secondary 1728×1117, library window at x=1602/y=37 with size 1592×1307, AeroSpace running. Do not conclude that missing host access is the cause from a queued-process probe.

The execution evidence and exact resume steps are retained in `~/code/bhekanik/.orchestrate/recto-writing-20261004/handover.md`. The Keychain prompt cleared on 2026-10-05; full relaunch now passes on both 0.1.2 and 0.1.3. The actual offline check still awaits network-disconnect approval.

On signed Recto 0.1.3 / build 522, release source `origin/main` / `6cf35b54cc8f904c614dd4548cb54df3b78758a7`, a held pointer drag inserted the exact selected Overflow text at the Raw editor drop caret and retained the notes. Draft Undo and Redo passed, followed by production sync. Agent-device 0.20.5 hardcodes a 50 ms initial hold for macOS pan; its public CLI cannot express the longer hold needed for this check. A contained public CGEvent helper used an 800 ms hold, observed AX range bounds and exact own-draft content guards. It verified the focused window and notes field because this SwiftUI window's AX raise action returned an error. This result verifies the installed drag journey; it does not resolve the earlier injected click and keyboard failures.
