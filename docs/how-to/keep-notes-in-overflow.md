# Keep spare material in Overflow

Open a draft from the macOS library and choose `Toggle Overflow` in the command palette or the Review menu. The tray button beside the formatting toolbar opens the same panel.

Type or paste notes, links, outlines or spare paragraphs into `Overflow notes`. Recto saves accepted edits on this Mac immediately and syncs them when connected. Close and reopen the draft to return to the notes. Overflow belongs to the library draft; standalone Markdown files do not have this panel.

To set a passage aside, select it in the draft and press Control-Shift-X, or choose `Stash selection in Overflow` in the command palette or the Review menu. The passage leaves the draft and joins the end of Overflow in one step. To bring Overflow text back, select it in Overflow, put the draft's caret where it belongs, and press Control-Return or Command-Return in Overflow: the text moves to the caret and leaves Overflow. With text selected in Overflow, Control-Return moves it rather than opening the contextual menu; right-click still opens the menu. Undo in the draft reverses either move in both places. Notes you typed since the move stay; if you have edited the moved text in Overflow, Undo leaves your edited copy there rather than guessing.

Select a passage in Overflow, press and hold inside the selection, then drag it into the draft. Release at the insertion indicator to add the passage there as one edit. The notes remain in Overflow. Rich, Raw and Vim accept drops; Preview is read-only. You can also copy and paste a passage. Undo and redo while the notes have focus affect the notes; the draft keeps its own history. Navigating draft history does not replace Overflow. Draft exports omit Overflow.

If two devices change the notes, Recto keeps both copies locally. Choose `View other copy`, copy any material you need, then choose `Keep this copy` or `Use other copy` and confirm the replacement.

Watch the status at the bottom of the panel. `Saved on this Mac · waiting to sync` means the local copy is durable. A storage refusal keeps the edit visible with `Retry saving notes`; keep that panel open or copy the unsaved edit before closing. Overflow accepts up to 64 KiB of UTF-8 text.

[Return to the macOS app guide](../../apple/RectoApp/README.md).
