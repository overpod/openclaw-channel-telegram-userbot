import { machineIdSync } from "node-machine-id"

function getEncryptionSecret(): string {
	const envKey = process.env.OPENCLAW_TELEGRAM_SESSION_KEY
	if (envKey) return envKey
	return machineIdSync(true)
}

async function deriveKey(secret: string): Promise<CryptoKey> {
	const keyMaterial = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		"HKDF",
		false,
		["deriveKey"],
	)

	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: new TextEncoder().encode("openclaw-telegram-userbot"),
			info: new TextEncoder().encode("aes-256-gcm-key"),
		},
		keyMaterial,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	)
}

let _key: CryptoKey | null = null

async function getKey(): Promise<CryptoKey> {
	if (!_key) {
		const secret = getEncryptionSecret()
		_key = await deriveKey(secret)
	}
	return _key
}

export async function encryptSession(sessionString: string): Promise<string> {
	const key = await getKey()
	const data = new TextEncoder().encode(sessionString)
	const iv = crypto.getRandomValues(new Uint8Array(12))
	const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data)

	const combined = new Uint8Array(12 + encrypted.byteLength)
	combined.set(iv, 0)
	combined.set(new Uint8Array(encrypted), 12)

	// Return as base64 for safe storage in config
	return Buffer.from(combined).toString("base64")
}

export async function decryptSession(encrypted: string): Promise<string> {
	const key = await getKey()
	const data = Buffer.from(encrypted, "base64")
	const iv = data.subarray(0, 12)
	const ciphertext = data.subarray(12)

	try {
		const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext)
		return new TextDecoder().decode(decrypted)
	} catch {
		throw new Error(
			"Failed to decrypt session. Wrong machine or corrupted data. Run 'bun run src/auth.ts' to create a new session.",
		)
	}
}

export function isEncryptedSession(value: string): boolean {
	// Encrypted sessions are base64 and longer than raw GramJS sessions
	try {
		const buf = Buffer.from(value, "base64")
		return buf.length > 12 && buf.toString("base64") === value
	} catch {
		return false
	}
}
