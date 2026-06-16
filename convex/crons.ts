import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Daily retention sweep of abandoned undo-tree branches (blueprint 07 §8, 03 §6).
crons.daily(
	"undo-tree retention sweep",
	{ hourUTC: 8, minuteUTC: 0 },
	internal.retention.sweep,
);

export default crons;
