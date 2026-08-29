import { describe, expect, it } from "vitest";
import {
	decryptCredential,
	encryptCredential,
	INVALID_CREDENTIAL_KEY_MESSAGE,
} from "./crypto";

const KEY = btoa("0123456789abcdef0123456789abcdef");

describe("AI credential encryption", () => {
	it("round-trips with a fresh 96-bit IV", async () => {
		const first = await encryptCredential("sk-or-secret", KEY);
		const second = await encryptCredential("sk-or-secret", KEY);

		expect(first.iv.byteLength).toBe(12);
		expect(new Uint8Array(first.iv)).not.toEqual(new Uint8Array(second.iv));
		expect(new TextDecoder().decode(first.ciphertext)).not.toContain(
			"sk-or-secret",
		);
		expect(await decryptCredential(first.ciphertext, first.iv, KEY)).toBe(
			"sk-or-secret",
		);
	});

	it("rejects keys that are not 256 bits", async () => {
		await expect(encryptCredential("secret", btoa("short"))).rejects.toThrow(
			INVALID_CREDENTIAL_KEY_MESSAGE,
		);
	});

	it("authenticates the ciphertext", async () => {
		const encrypted = await encryptCredential("secret", KEY);
		const tampered = encrypted.ciphertext.slice(0);
		const bytes = new Uint8Array(tampered);
		bytes[0] = (bytes[0] ?? 0) ^ 1;

		await expect(
			decryptCredential(tampered, encrypted.iv, KEY),
		).rejects.toThrow();
	});
});
