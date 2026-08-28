import { expect, test } from "bun:test";

import { loadBundle, parseKeys, type RectoVimApi, TestHost } from "./harness";

const api: RectoVimApi = await loadBundle(
	`${import.meta.dir}/../dist/recto-vim.js`,
);

function press(keys: string, host: TestHost) {
	for (const { key, mods } of parseKeys(keys)) {
		host.beginKey();
		host.endKey(JSON.parse(api.handleKey(key, mods)));
	}
}

/**
 * `saveState`/`restoreState` is the persistence hook the native client uses to
 * carry registers and marks across a relaunch. It has to survive a *fresh
 * session*, which is what makes it worth testing here rather than trusting the
 * round trip inside one.
 */
test("named registers survive a new session", () => {
	const first = new TestHost(api);
	api.init("alpha\nbeta\n", first);
	api.setCursor(0, 0);
	press('"ayy', first);
	const saved = api.saveState();

	const second = new TestHost(api);
	api.init("gamma\n", second);
	api.setCursor(0, 0);
	api.restoreState(saved);
	press('"ap', second);

	expect(api.getText()).toBe("gamma\nalpha\n");
});

test("marks survive a new session over the same text", () => {
	const first = new TestHost(api);
	api.init("one\ntwo\nthree\n", first);
	api.setCursor(2, 0);
	press("ma", first);
	const saved = api.saveState();

	const second = new TestHost(api);
	api.init("one\ntwo\nthree\n", second);
	api.setCursor(0, 0);
	api.restoreState(saved);
	press("`ax", second);

	expect(api.getText()).toBe("one\ntwo\nhree\n");
});

test("restoring nothing is not an error", () => {
	const host = new TestHost(api);
	api.init("one\n", host);
	api.restoreState("");
	api.restoreState("{}");
	expect(api.getText()).toBe("one\n");
});

test("marks are per session, registers are per context", () => {
	// Vim's registers are global by design, and the core keeps them on a
	// module-level `vimGlobalState` that `RectoVim.init` does not reset. So two
	// documents sharing one JSContext share their registers — which is what vim
	// does — while marks belong to the buffer and start empty.
	const host = new TestHost(api);
	api.init("one\n", host);
	api.setCursor(0, 0);
	press('"zyy', host);

	const other = new TestHost(api);
	api.init("two\n", other);
	const state = JSON.parse(api.saveState());
	expect(state.marks).toEqual({});
	expect(state.registers.z.text).toBe("one\n");
});
