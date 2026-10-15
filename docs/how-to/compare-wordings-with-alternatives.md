# Compare wordings with alternatives

Put the caret in a word of a library draft, or select a passage, and press Control-Shift-A. You can also choose `Alternatives for selection` in the command palette or the Review menu. The alternatives panel opens beside the draft.

Choose `Word`, `Sentence` or `Paragraph` at the top of the panel to work on the word, sentence or paragraph around the caret. A selection opens as a word when it is one word and as a sentence when it spans several; a passage that already has alternatives opens on its own scope. Type another wording into `Add a wording` and press Return. The passage gets an underline, and the first wording in the list is your original. Add as many wordings as you like.

To compare wordings, press the Up and Down arrows in the panel. Each wording replaces the passage in place, so you read it in its sentence. While one is on show, the draft does not accept typing. Press Return with the field empty, or click back into the draft, to keep the wording on show. Press Escape to put back the wording you started with. When a word follows "a" or "an" and the wording on show starts with a different sound, the article changes with it ("a thumbtack" becomes "an eraser"), using the same rule as the prose linter; keeping the wording keeps both in one Undo.

With AI on, `Suggest with AI` in the panel, or Control-Shift-G in the draft, asks for up to five other wordings of the passage. They join the list with a sparkle beside them and nothing in the draft changes until you choose one. One Undo removes the whole batch. The AI sees the draft so its wordings fit their place, and it never replaces your text on its own.

The underline is quiet while the passage shows its original and takes the accent colour while it shows another wording. Point at it to see how many wordings it has. Wordings you wrote have a dot; wordings suggested by AI have a sparkle. To remove a wording, click the minus beside it. A passage left with only its original loses its underline.

Keeping a wording, adding one and removing one are each a single Undo. Undo and the history panel bring back the wordings together with the text they belong to. Typing before or after a passage moves its alternatives with it. Typing inside it edits the wording on show. An edit that cuts across the passage's edge keeps the wordings but hides the underline, so Recto never rewrites text it can no longer find exactly.

Alternatives sync with the draft to your other Macs. The web app underlines them the same way and has the same panel: `Alternatives for selection` in the command palette, or Control-Shift-A on a Mac (Alt+Shift+A elsewhere). In Rich mode on the web, a selection must be text that appears once in the draft; for repeated text, select it in Raw. AI wordings are on the Mac for now. Exports and copies contain only the wording on show. Alternatives are not available for standalone Markdown files.

[Return to the macOS app guide](../../apple/RectoApp/README.md).
