import { describe, expect, it } from "vitest";

import { findFlags } from "@/lib/markdown/flags";
import { extractOutline } from "@/lib/outline/extract";
import { headingsWithFlags } from "@/lib/outline/flagged-headings";

describe("headingsWithFlags", () => {
	it("marks the heading above each flag, none for flags before the first", () => {
		const md = [
			"Intro <!--flag-->",
			"",
			"# One",
			"",
			"Text <!--flag: a-->",
			"",
			"## One point one",
			"",
			"Clean.",
			"",
			"# Two",
			"",
			"More <!--flag: b--> and <!--flag: c-->",
			"",
		].join("\n");
		const flagged = headingsWithFlags(extractOutline(md), findFlags(md));
		expect([...flagged].sort()).toEqual([0, 2]);
	});
});
