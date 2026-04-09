#!/usr/bin/env bun
import { createInterface } from "node:readline"
import { TelegramClient } from "telegram"
import { StringSession } from "telegram/sessions/index.js"
import { encryptSession } from "./crypto.js"

const rl = createInterface({ input: process.stdin, output: process.stderr })
const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve))

console.error("\n🔑 Telegram Userbot Authentication\n")
console.error("Get API credentials from https://my.telegram.org\n")

const apiId = Number(await ask("API ID: "))
const apiHash = await ask("API Hash: ")
const phoneNumber = await ask("Phone number (with country code): ")

const session = new StringSession("")
const client = new TelegramClient(session, apiId, apiHash, {
	connectionRetries: 5,
})

await client.start({
	phoneNumber: async () => phoneNumber,
	phoneCode: async () => await ask("Verification code: "),
	password: async () => await ask("2FA password (if enabled): "),
	onError: (err) => console.error("Error:", err.message),
})

const sessionString = client.session.save() as unknown as string
await client.disconnect()

console.error("\n✅ Authentication successful!\n")

// Offer encryption
const encrypt = await ask("Encrypt session with machine ID? (y/n): ")

if (encrypt.toLowerCase() === "y") {
	const encrypted = await encryptSession(sessionString)
	console.error("\n🔒 Encrypted session (machine-bound):")
	console.log(encrypted)
	console.error("\n⚠️  This session only works on this machine.")
} else {
	console.error("\n📋 Session string:")
	console.log(sessionString)
}

console.error("\nAdd to your OpenClaw config:")
console.error('  openclaw config set channels.telegram-userbot.sessionString "YOUR_SESSION"')
console.error(`  openclaw config set channels.telegram-userbot.apiId ${apiId}`)
console.error(`  openclaw config set channels.telegram-userbot.apiHash "${apiHash}"\n`)

rl.close()
process.exit(0)
