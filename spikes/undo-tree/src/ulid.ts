/** Minimal ULID — lexicographically sortable, no extra dependency. */
export function ulid(): string {
	const time = Date.now();
	const timeChars = encodeTime(time, 10);
	const randomChars = encodeRandom(16);
	return timeChars + randomChars;
}

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(now: number, len: number): string {
	let str = "";
	for (let i = len - 1; i >= 0; i--) {
		str = ENCODING[now % 32] + str;
		now = Math.floor(now / 32);
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
