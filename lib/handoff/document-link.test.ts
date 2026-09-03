import { afterEach, describe, expect, it } from "vitest";

import {
	isMacOSPlatform,
	isPlausibleDocumentId,
	macAppDocumentURL,
	parseDocSearchParam,
	resolveDocumentDeepLink,
	stripDocSearchParam,
	webDocumentURL,
} from "./document-link";

describe("parseDocSearchParam", () => {
	it("reads doc from a query string, with or without the leading ?", () => {
		expect(parseDocSearchParam("?doc=k57abcdefghijklmnop")).toBe(
			"k57abcdefghijklmnop",
		);
		expect(parseDocSearchParam("doc=k57abcdefghijklmnop")).toBe(
			"k57abcdefghijklmnop",
		);
	});

	it("returns null when the param is missing or empty", () => {
		expect(parseDocSearchParam("")).toBeNull();
		expect(parseDocSearchParam("?other=1")).toBeNull();
		expect(parseDocSearchParam("?doc=")).toBeNull();
		expect(parseDocSearchParam("?doc=   ")).toBeNull();
	});

	it("keeps the first value when other params are present", () => {
		expect(parseDocSearchParam("?pane=a&doc=k57abcdefghijklmnop&x=1")).toBe(
			"k57abcdefghijklmnop",
		);
	});
});

describe("stripDocSearchParam", () => {
	it("removes doc and preserves sibling params, path, and hash", () => {
		expect(
			stripDocSearchParam(
				"https://recto.example/?pane=a&doc=k57abcdefghijklmnop#h",
			),
		).toBe("/?pane=a#h");
	});

	it("leaves a URL without doc unchanged besides dropping the origin", () => {
		expect(stripDocSearchParam("https://recto.example/?pane=a")).toBe(
			"/?pane=a",
		);
	});
});

describe("macAppDocumentURL", () => {
	it("is recto://document/<id>", () => {
		expect(macAppDocumentURL("k57abcdefghijklmnop")).toBe(
			"recto://document/k57abcdefghijklmnop",
		);
	});
});

describe("webDocumentURL", () => {
	it("appends ?doc= onto the origin, stripping a trailing slash", () => {
		expect(
			webDocumentURL("https://recto.example/", "k57abcdefghijklmnop"),
		).toBe("https://recto.example/?doc=k57abcdefghijklmnop");
	});
});

describe("isMacOSPlatform", () => {
	it("is true for userAgentData macOS", () => {
		expect(
			isMacOSPlatform({
				platform: "Win32",
				userAgentData: { platform: "macOS" },
			}),
		).toBe(true);
	});

	it("is true for navigator.platform containing Mac", () => {
		expect(isMacOSPlatform({ platform: "MacIntel" })).toBe(true);
		// iPadOS desktop-mode Safari: MacIntel with a touch screen
		expect(isMacOSPlatform({ platform: "MacIntel", maxTouchPoints: 5 })).toBe(
			false,
		);
		expect(
			isMacOSPlatform({
				userAgentData: { platform: "macOS" },
				maxTouchPoints: 5,
			}),
		).toBe(false);
		expect(isMacOSPlatform({ platform: "MacIntel", maxTouchPoints: 0 })).toBe(
			true,
		);
		expect(isMacOSPlatform({ platform: "MacPPC" })).toBe(true);
	});

	it("is false on Windows, Linux, iPhone, and missing navigator", () => {
		expect(isMacOSPlatform({ platform: "Win32" })).toBe(false);
		expect(isMacOSPlatform({ platform: "Linux x86_64" })).toBe(false);
		expect(isMacOSPlatform({ platform: "iPhone" })).toBe(false);
		expect(isMacOSPlatform(undefined)).toBe(false);
	});
});

describe("resolveDocumentDeepLink", () => {
	const id = "k57abcdefghijklmnop";

	it("opens a document already in the workspace list without waiting on access", () => {
		expect(
			resolveDocumentDeepLink({
				param: id,
				listedIds: new Set([id]),
				access: undefined,
			}),
		).toEqual({ kind: "open", documentId: id });
	});

	it("waits when the id is not listed and access has not loaded", () => {
		expect(
			resolveDocumentDeepLink({
				param: id,
				listedIds: new Set(),
				access: undefined,
			}),
		).toEqual({ kind: "wait" });
	});

	it("opens when the id is not listed but the user can access it", () => {
		expect(
			resolveDocumentDeepLink({
				param: id,
				listedIds: new Set(),
				access: { role: "commenter" },
			}),
		).toEqual({ kind: "open", documentId: id });
	});

	it("clears when the id is not listed and access is denied", () => {
		expect(
			resolveDocumentDeepLink({
				param: id,
				listedIds: new Set(),
				access: null,
			}),
		).toEqual({ kind: "clear" });
	});

	it("clears implausible params without waiting", () => {
		expect(
			resolveDocumentDeepLink({
				param: "../etc",
				listedIds: new Set(),
				access: undefined,
			}),
		).toEqual({ kind: "clear" });
		expect(
			resolveDocumentDeepLink({
				param: "short",
				listedIds: new Set(),
				access: undefined,
			}),
		).toEqual({ kind: "clear" });
		expect(isPlausibleDocumentId(id)).toBe(true);
	});

	it("clears a missing param", () => {
		expect(
			resolveDocumentDeepLink({
				param: null,
				listedIds: new Set([id]),
				access: undefined,
			}),
		).toEqual({ kind: "clear" });
	});
});

describe("stripDocSearchParam uses the History-API shape", () => {
	afterEach(() => {
		window.history.replaceState(null, "", "/");
	});

	it("is what replaceState should receive so a refresh does not re-apply", () => {
		window.history.replaceState(null, "", "/?doc=k57abcdefghijklmnop&x=1");
		const next = stripDocSearchParam(window.location.href);
		window.history.replaceState(null, "", next);
		expect(parseDocSearchParam(window.location.search)).toBeNull();
		expect(window.location.search).toBe("?x=1");
	});
});
