const AES_GCM_IV_BYTES = 12;
const AES_256_BYTES = 32;

export const INVALID_CREDENTIAL_KEY_MESSAGE =
	"AI_CREDENTIAL_KEY must be a base64-encoded 32-byte key.";

function decodeBase64(value: string): ArrayBuffer {
	let decoded: string;
	try {
		decoded = atob(value);
	} catch {
		throw new Error(INVALID_CREDENTIAL_KEY_MESSAGE);
	}
	return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
		.buffer;
}

export async function importCredentialKey(
	encodedKey: string,
): Promise<CryptoKey> {
	const bytes = decodeBase64(encodedKey);
	if (bytes.byteLength !== AES_256_BYTES) {
		throw new Error(INVALID_CREDENTIAL_KEY_MESSAGE);
	}
	return await crypto.subtle.importKey(
		"raw",
		bytes,
		{ name: "AES-GCM" },
		false,
		["encrypt", "decrypt"],
	);
}

export async function encryptCredential(
	plaintext: string,
	key: CryptoKey,
): Promise<{ ciphertext: ArrayBuffer; iv: ArrayBuffer }> {
	const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		new TextEncoder().encode(plaintext),
	);
	return { ciphertext, iv: iv.buffer };
}

export async function decryptCredential(
	ciphertext: ArrayBuffer,
	iv: ArrayBuffer,
	key: CryptoKey,
): Promise<string> {
	if (iv.byteLength !== AES_GCM_IV_BYTES) {
		throw new Error("Stored AI credential has an invalid IV.");
	}
	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: new Uint8Array(iv) },
		key,
		ciphertext,
	);
	return new TextDecoder().decode(plaintext);
}
