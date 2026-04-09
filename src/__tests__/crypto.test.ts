import { describe, expect, it } from "bun:test"
import { decryptSession, encryptSession, isEncryptedSession } from "../crypto.js"

describe("crypto", () => {
	it("should encrypt and decrypt session", async () => {
		const original = "1BQANOTREALSESSIONxyz123456789"
		const encrypted = await encryptSession(original)

		expect(encrypted).not.toBe(original)
		expect(isEncryptedSession(encrypted)).toBe(true)

		const decrypted = await decryptSession(encrypted)
		expect(decrypted).toBe(original)
	})

	it("should detect non-encrypted sessions", () => {
		expect(isEncryptedSession("1BQANOTREALSESSIONxyz")).toBe(false)
		expect(isEncryptedSession("not-base64!!!")).toBe(false)
	})

	it("should fail decryption with tampered data", async () => {
		const encrypted = await encryptSession("test-session")
		const tampered = `${encrypted.slice(0, -4)}XXXX`

		expect(decryptSession(tampered)).rejects.toThrow()
	})
})
