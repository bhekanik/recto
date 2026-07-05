import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Daily retention sweep of abandoned undo-tree branches (blueprint 07 §8, 03 §6).
crons.daily(
	"undo-tree retention sweep",
	{ hourUTC: 8, minuteUTC: 0 },
	internal.retention.sweep,
);

// Daily RAG re-embed sweep (plan 009 Phase C). Embeds stale documents server-side
// via OpenRouter using the Convex-side OPENROUTER_API_KEY (see
// convex/embeddings.ts → reindexSweep). The client "Re-index drafts" command
// remains available for on-demand re-indexing.
crons.daily(
	"rag re-embed sweep",
	{ hourUTC: 9, minuteUTC: 0 },
	internal.embeddings.reindexSweep,
);

// Daily orphaned-blob GC (plan 013). Deletes stored files no longer referenced
// by any document markdown or docNodes history, after a 24h grace window (see
// convex/files.ts → orphanSweep). Runs after the 08:00 retention sweep so
// freshly-pruned docNodes don't hold references.
crons.daily(
	"orphaned image blob sweep",
	{ hourUTC: 10, minuteUTC: 0 },
	internal.files.orphanSweep,
	{},
);

export default crons;
