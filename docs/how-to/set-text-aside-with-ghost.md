# Set text aside with Ghost

When you are not sure a passage belongs, ghost it instead of deleting it. Select the passage in a library draft and press Control-/, or choose `Ghost or revive` in the command palette or the Review menu. The passage stays where it is but fades to a faint tint, so you can read the draft as if it were gone and still see what you set aside.

To bring it back, put the caret anywhere in the ghosted passage and press Control-/ again. Ghosting and reviving are each one Undo, and the history panel restores ghosts together with the text they belong to.

Ghosted text is still text. You can edit it while it is faded, and typing inside it stays faded. If an edit removes part of it, the rest stays ghosted; deleting all of it removes the ghost. Ghosting text next to another ghost joins them into one.

Readers do not see ghosted text. Preview, Copy as rich text, and the Markdown, HTML and Word exports leave it out. Copy Markdown and the draft itself keep it, because those are your source. For a Word export, Recto sends the server the ghosted ranges with a fingerprint of the draft; if the server's copy differs, the export stops and asks you to let the draft sync first, rather than cutting the wrong text.

Ghosts sync with the draft to your other Macs. The web app keeps them through its own edits and leaves them out of its Preview, copies and exports too; it draws them faded too, but ghosting and reviving are on the Mac for now. Ghost is not available for standalone Markdown files.

[Return to the macOS app guide](../../apple/RectoApp/README.md).
