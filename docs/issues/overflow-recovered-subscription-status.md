# Recovered Overflow subscriptions can retain an old error

Status: open, nonblocking status correction.

At candidate `0821b91057729ce1d6281b7d22a09c2ce6291889`, `apple/Packages/RectoSync/Sources/RectoSync/OverflowSync.swift` records subscription failures in the note row but does not clear that message on a successful subscription update. Clean notes are absent from the dirty-only retry loop, so the panel can continue showing the previous error after remote updates resume. Notes remain durable and the subscription continues applying updates.

Clear the recovered subscription error while preserving any outstanding save failure. Verify an initially failed clean subscription reconnects, applies remote notes and clears its old error without requiring a local edit; a dirty pending save must retain its failure.
