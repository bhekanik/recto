/**
 * Pure streak/goal math — no React, no Convex, no date library. The UI calls
 * these; this is the single place the streak/goal semantics live. (plan 002)
 *
 * Streak semantics ("count only days you write — off-days don't break-shame"):
 * a streak is the run of consecutive *written* calendar days (words > 0) with no
 * skipped day between them, counting back from `today`, EXCEPT `today` itself may
 * be unwritten — you haven't necessarily written yet today, so an unwritten today
 * does not reset the streak. Concretely: build a Set of written dates; start the
 * cursor at today (if written, count it and step back; if not, start at
 * yesterday); walk backwards while each cursor date is in the set; stop at the
 * first unwritten day. So writing yesterday but not yet today still counts
 * yesterday's run; a fully skipped day (unwritten, with written days before it)
 * ends the backward walk there.
 */

export type DailyStat = { date: string; words: number }; // date = "YYYY-MM-DD" local

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/** Local "YYYY-MM-DD" for a Date (default: now). Uses local time, not UTC. */
export function localDateKey(d: Date = new Date()): string {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function daysInMonth(year: number, month: number): number {
	if (month === 2) {
		const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
		return leap ? 29 : 28;
	}
	return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * The local date key one calendar day before `key`.
 *
 * Deliberately pure string/integer arithmetic, with no Date and no clock: `key`
 * is already a local calendar date, so stepping it must not depend on a
 * timezone. Going through a Date and subtracting 24h lands on the wrong
 * calendar day wherever DST makes the local day 23 or 25 hours long — in
 * America/Sao_Paulo, 2018-11-05 local midnight minus 24h is 2018-11-03 23:00,
 * which reads back as 2018-11-03 and skips 2018-11-04, silently breaking a
 * streak.
 */
function previousDateKey(key: string): string {
	const [rawYear, rawMonth, rawDay] = key.split("-").map(Number);
	let year = rawYear ?? 1970;
	let month = rawMonth ?? 1;
	let day = (rawDay ?? 1) - 1;
	if (day < 1) {
		month -= 1;
		if (month < 1) {
			month = 12;
			year -= 1;
		}
		day = daysInMonth(year, month);
	}
	return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Current streak length counting back from `today`, counting ONLY days the user
 * wrote (words > 0). An unwritten `today` does not reset the streak. Returns an
 * integer >= 0. See the module-level comment for the full semantics.
 */
export function currentStreak(stats: DailyStat[], today: string): number {
	const written = new Set<string>();
	for (const { date, words } of stats) {
		if (words > 0) written.add(date);
	}
	if (written.size === 0) return 0;

	// Start at today if written, else at yesterday (no shame for not writing yet).
	let cursor = written.has(today) ? today : previousDateKey(today);
	let streak = 0;
	while (written.has(cursor)) {
		streak += 1;
		cursor = previousDateKey(cursor);
	}
	return streak;
}

export type GoalKind = "at-least" | "about" | "at-most";

export type GoalProgress = {
	ratio: number; // clamped 0..1 for the ring/bar fill
	met: boolean; // goal satisfied?
	remaining: number; // words to go (>=0); 0 once met
};

/** "about" goals count as met within this fractional band of the target (±10%). */
const ABOUT_BAND = 0.1;

function clamp01(n: number): number {
	return Math.min(1, Math.max(0, n));
}

/** Progress of `words` toward `target` under the given goal kind. */
export function goalProgress(
	words: number,
	target: number,
	kind: GoalKind,
): GoalProgress {
	if (target <= 0) {
		return { ratio: 0, met: false, remaining: 0 };
	}

	const ratio = clamp01(words / target);
	const remaining = Math.max(target - words, 0);

	let met: boolean;
	switch (kind) {
		case "at-least":
			met = words >= target;
			break;
		case "about":
			met = Math.abs(words - target) <= target * ABOUT_BAND;
			break;
		case "at-most":
			met = words <= target;
			break;
	}

	return { ratio, met, remaining };
}
