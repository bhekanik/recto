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

export default crons;
