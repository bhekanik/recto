"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDebouncedCallback } from "use-debounce";

import { splitFrontmatter } from "@/lib/markdown";
import type { LintIssue, LintOptions } from "./types";

type LintResult = {
	/** Issues with offsets into the body — for Milkdown (rich) via text re-search. */
	bodyIssues: LintIssue[];
	/** Same issues shifted into the full canonical string — for CodeMirror (raw/vim). */
	docIssues: LintIssue[];
	/** Number of issues (the status-bar count). */
	count: number;
};

const EMPTY: LintResult = { bodyIssues: [], docIssues: [], count: 0 };
const DEBOUNCE_MS = 400;

type AnalyzeFn = typeof import("./analyze")["analyze"];

/**
 * Lazily load `analyze` for the main-thread fallback. Dynamic so the heavy
 * retext analysis chunk only loads in the browser when the worker is unavailable,
 * not in the main client bundle. (analyze.ts further defers write-good past SSR.)
 */
let analyzePromise: Promise<AnalyzeFn> | null = null;
function loadAnalyze(): Promise<AnalyzeFn> {
	if (!analyzePromise) {
		analyzePromise = import("./analyze").then((m) => m.analyze);
	}
	return analyzePromise;
}

/**
 * Shift body-relative issues into full-canonical-doc coordinates for CodeMirror,
 * whose document string is the whole canonical Markdown (frontmatter included).
 * `splitFrontmatter` re-stringifies the body, so its offset within the canonical
 * string isn't a fixed frontmatter length — locate it by substring. If the body
 * can't be located verbatim (rare normalization drift), fall back to the body
 * offsets unshifted rather than mis-placing every highlight.
 */
function shiftToDoc(
	canonical: string,
	body: string,
	bodyIssues: LintIssue[],
): LintIssue[] {
	if (bodyIssues.length === 0) return bodyIssues;
	const base = body ? canonical.indexOf(body) : 0;
	const shift = base >= 0 ? base : 0;
	if (shift === 0) return bodyIssues;
	return bodyIssues.map((i) => ({
		...i,
		from: i.from + shift,
		to: i.to + shift,
	}));
}

/**
 * Schedule `fn` to run when the main thread is idle, with a timeout backstop.
 * Returns a cancel function. Used only on the worker-unavailable fallback path.
 */
function scheduleIdle(fn: () => void): () => void {
	if (typeof window !== "undefined" && "requestIdleCallback" in window) {
		const handle = window.requestIdleCallback(fn, { timeout: 500 });
		return () => window.cancelIdleCallback(handle);
	}
	const handle = setTimeout(fn, 0);
	return () => clearTimeout(handle);
}

/**
 * Run the prose linter off the typing hot path. Debounced 400ms after each
 * `changeSignal` change; reads the live editor text via `getMarkdown` (never a
 * reactive query — the editor owns live state), strips frontmatter, and analyzes
 * the body in a Web Worker. Falls back to an idle-scheduled main-thread call if
 * the worker can't be constructed (analysis of a typical doc is sub-10ms).
 *
 * Returns `bodyIssues` (for Milkdown), `docIssues` (for CodeMirror), and `count`.
 * When `enabled` is false it does no work and returns empties.
 */
export function useProseLint(
	getMarkdown: () => string,
	options: LintOptions,
	enabled: boolean,
	changeSignal: unknown,
): LintResult {
	const [result, setResult] = useState<LintResult>(EMPTY);

	const getMarkdownRef = useRef(getMarkdown);
	getMarkdownRef.current = getMarkdown;
	const optionsRef = useRef(options);
	optionsRef.current = options;

	const workerRef = useRef<Worker | null>(null);
	const workerBrokenRef = useRef(false);
	const cancelIdleRef = useRef<(() => void) | null>(null);
	// Monotonic request id so a slow worker reply for stale text is ignored.
	const reqIdRef = useRef(0);

	// Build the worker once. If construction throws (Turbopack/Bun can't bundle
	// the worker), flag it and use the main-thread idle fallback instead.
	useEffect(() => {
		try {
			const worker = new Worker(new URL("./worker.ts", import.meta.url));
			workerRef.current = worker;
		} catch {
			workerBrokenRef.current = true;
		}
		return () => {
			workerRef.current?.terminate();
			workerRef.current = null;
			cancelIdleRef.current?.();
		};
	}, []);

	const apply = useCallback((canonical: string, bodyIssues: LintIssue[]) => {
		const body = splitFrontmatter(canonical).body;
		setResult({
			bodyIssues,
			docIssues: shiftToDoc(canonical, body, bodyIssues),
			count: bodyIssues.length,
		});
	}, []);

	const run = useDebouncedCallback(() => {
		if (!enabled) return;
		const canonical = getMarkdownRef.current();
		const body = splitFrontmatter(canonical).body;
		const opts = optionsRef.current;
		const id = ++reqIdRef.current;

		const worker = workerRef.current;
		if (worker && !workerBrokenRef.current) {
			worker.postMessage({ id, text: body, options: opts });
			return;
		}
		// Main-thread fallback — run when idle so typing never stutters. `analyze`
		// is imported lazily so its analysis chunk loads only when the worker is
		// unavailable, in the browser. (`analyze` itself further defers write-good
		// past SSR module-eval — see the note in analyze.ts.)
		cancelIdleRef.current?.();
		cancelIdleRef.current = scheduleIdle(() => {
			if (id !== reqIdRef.current) return;
			void loadAnalyze().then(async (analyze) => {
				const issues = await analyze(body, opts);
				if (id !== reqIdRef.current) return;
				apply(canonical, issues);
			});
		});
	}, DEBOUNCE_MS);

	// Wire the worker's reply once the worker exists.
	useEffect(() => {
		const worker = workerRef.current;
		if (!worker) return;
		const onMessage = (
			event: MessageEvent<{ id: number; issues: LintIssue[] }>,
		) => {
			if (event.data.id !== reqIdRef.current) return;
			apply(getMarkdownRef.current(), event.data.issues);
		};
		const onError = () => {
			// Worker failed at runtime — degrade to the main thread from here on.
			workerBrokenRef.current = true;
		};
		worker.addEventListener("message", onMessage);
		worker.addEventListener("error", onError);
		return () => {
			worker.removeEventListener("message", onMessage);
			worker.removeEventListener("error", onError);
		};
	}, [apply]);

	// Re-analyze on edits (debounced) and whenever enable/options change. When the
	// linter is off, clear immediately so highlights vanish the moment it's toggled.
	// `options`/`changeSignal` are intentional re-analyze triggers read via refs,
	// so they aren't referenced directly in the body but must stay in the deps.
	// biome-ignore lint/correctness/useExhaustiveDependencies: options + changeSignal are deliberate re-run triggers consumed through refs
	useEffect(() => {
		if (!enabled) {
			run.cancel();
			setResult(EMPTY);
			return;
		}
		run();
	}, [enabled, options, changeSignal, run]);

	return useMemo(() => (enabled ? result : EMPTY), [enabled, result]);
}
