/// <reference lib="webworker" />
import { analyze } from "./analyze";
import type { LintIssue, LintOptions } from "./types";

type LintRequest = { id: number; text: string; options: LintOptions };
type LintResponse = { id: number; issues: LintIssue[] };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (event: MessageEvent<LintRequest>) => {
	const { id, text, options } = event.data;
	const issues = await analyze(text, options);
	const response: LintResponse = { id, issues };
	ctx.postMessage(response);
};
