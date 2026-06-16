/**
 * Minimal ULID — lexicographically sortable by creation time, globally unique,
 * no extra dependency (blueprint README §6, 07 §3.1). Client-generated so a node
 * id can be minted offline/optimistically without a server round-trip.
 */
export function ulid(): string {
	return encodeTime(Date.now(), 10) + encodeRandom(16);
}

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

function encodeTime(now: number, len: number): string {
	let str = "";
	let value = now;
	for (let i = len - 1; i >= 0; i--) {
		str = ENCODING[value % 32] + str;
		value = Math.floor(value / 32);
	}
	return str;
}

function encodeRandom(len: number): string {
	const bytes = crypto.getRandomValues(new Uint8Array(len));
	let str = "";
	for (const byte of bytes) {
		str += ENCODING[byte % 32];
	}
	return str;
}
