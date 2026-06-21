"use client";

import { useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useRef } from "react";
import { useDebouncedCallback } from "use-debounce";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
	currentStreak,
	type GoalKind,
	type GoalProgress,
	goalProgress,
	localDateKey,
} from "@/lib/stats/streak";
import type { GoalScope } from "@/lib/studio/use-studio-settings";

type UseWritingStatsArgs = {
	activeDocId: Id<"documents"> | null;
	/** True once the active doc's sync state exists (gates the session baseline). */
	hasActiveSync: boolean;
	activeWordCount: number;
	goalScope: GoalScope;
	wordGoalTarget: number;
	dailyGoalTarget: number;
	wordGoalKind: GoalKind;
};

export type UseWritingStatsResult = {
	sessionWords: number;
	streakDays: number;
	goalProgressValue: GoalProgress;
	goalTarget: number;
	goalLabel: string;
};

/**
 * Word goals, per-session stats, and the cross-device streak (plan 002).
 *
 * Tracks a per-document session baseline (the word count first observed this
 * mount), reads the cross-device daily totals from Convex for the streak, and
 * exposes the goal progress/label for whichever scope the setting selects. The
 * day's total is flushed to Convex on a coarse ~30s debounce (off the typing hot
 * path) and once more on unmount / tab close.
 */
export function useWritingStats({
	activeDocId,
	hasActiveSync,
	activeWordCount,
	goalScope,
	wordGoalTarget,
	dailyGoalTarget,
	wordGoalKind,
}: UseWritingStatsArgs): UseWritingStatsResult {
	// Per-document session baseline: the word count first observed this mount.
	// A new mount = a new session; switching docs keeps each doc's own baseline.
	const sessionBaselineRef = useRef<Map<Id<"documents">, number>>(new Map());
	if (
		activeDocId &&
		hasActiveSync &&
		!sessionBaselineRef.current.has(activeDocId)
	) {
		sessionBaselineRef.current.set(activeDocId, activeWordCount);
	}
	const sessionBaseline = activeDocId
		? (sessionBaselineRef.current.get(activeDocId) ?? activeWordCount)
		: activeWordCount;
	const sessionWords = Math.max(activeWordCount - sessionBaseline, 0);

	// Cross-device daily totals (the streak source of truth lives in Convex).
	const dailyStats = useQuery(api.writingStats.list, {});
	const today = localDateKey();
	const streakDays = dailyStats ? currentStreak(dailyStats, today) : 0;
	const persistedTodayWords =
		dailyStats?.find((s) => s.date === today)?.words ?? 0;
	// "Today's words" for the daily goal = the day's high-water mark, plus the
	// live document count if it's currently higher (single active doc is typical).
	const dailyWords = Math.max(persistedTodayWords, activeWordCount);

	// Goal progress for whichever scope the (switchable) setting selects.
	const goalWords = goalScope === "daily" ? dailyWords : activeWordCount;
	const goalTarget = goalScope === "daily" ? dailyGoalTarget : wordGoalTarget;
	const goalProgressValue = useMemo(
		() => goalProgress(goalWords, goalTarget, wordGoalKind),
		[goalWords, goalTarget, wordGoalKind],
	);
	const goalLabel =
		goalTarget > 0
			? `${goalScope === "daily" ? "Daily goal" : "Goal"}: ${goalWords.toLocaleString()} / ${goalTarget.toLocaleString()} words`
			: "Set word goal";

	// Low-frequency daily-total flush — coarse on purpose. Streaks need only
	// day-granularity, so a ~30s debounce keeps stats writes off the typing hot
	// path; the mutation is monotonic, so redundant/late flushes are harmless.
	const recordStats = useMutation(api.writingStats.record);
	const dailyWordsRef = useRef(dailyWords);
	dailyWordsRef.current = dailyWords;
	const flushDailyTotal = useDebouncedCallback((words: number) => {
		if (words <= 0) return;
		void recordStats({ date: localDateKey(), words });
	}, 30_000);

	// Re-arm the debounce whenever the day's word count changes (not per save).
	useEffect(() => {
		flushDailyTotal(dailyWords);
	}, [dailyWords, flushDailyTotal]);

	// Flush once on unmount / tab close so the day's last words are recorded.
	useEffect(() => {
		const flushNow = () => {
			flushDailyTotal.cancel();
			if (dailyWordsRef.current > 0) {
				void recordStats({
					date: localDateKey(),
					words: dailyWordsRef.current,
				});
			}
		};
		window.addEventListener("beforeunload", flushNow);
		return () => {
			window.removeEventListener("beforeunload", flushNow);
			flushNow();
		};
	}, [flushDailyTotal, recordStats]);

	return { sessionWords, streakDays, goalProgressValue, goalTarget, goalLabel };
}
