import { TelegramClient } from "telegram"
import { StringSession } from "telegram/sessions/index.js"
import type { PluginConfig } from "./config.js"

let _client: TelegramClient | null = null

export async function createTelegramClient(config: PluginConfig): Promise<TelegramClient> {
	if (_client?.connected) return _client

	const session = new StringSession(config.sessionString)

	const client = new TelegramClient(session, config.apiId, config.apiHash, {
		connectionRetries: 5,
		autoReconnect: true,
	})

	await client.connect()
	console.error("[telegram-userbot] Connected to Telegram")

	_client = client
	return client
}

export async function disconnectClient(): Promise<void> {
	if (_client?.connected) {
		await _client.disconnect()
		console.error("[telegram-userbot] Disconnected from Telegram")
		_client = null
	}
}

export function getClient(): TelegramClient | null {
	return _client
}
