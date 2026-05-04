import { TelegramClient } from "telegram"
import { LogLevel } from "telegram/extensions/Logger.js"
import { StringSession } from "telegram/sessions/index.js"
import type { PluginConfig } from "./config.js"

const clients = new Map<string, TelegramClient>()
const pendingClients = new Map<string, Promise<TelegramClient>>()

function normalizeAccountId(accountId?: string): string {
	return accountId?.trim() || "default"
}

function isTransientTelegramError(error: unknown): boolean {
	if (!(error instanceof Error)) return false
	return error.message === "TIMEOUT"
}

export async function createTelegramClient(
	config: PluginConfig,
	accountId?: string,
): Promise<TelegramClient> {
	const key = normalizeAccountId(accountId)
	const existing = clients.get(key)
	if (existing?.connected) return existing

	const pending = pendingClients.get(key)
	if (pending) return await pending

	const connectPromise = (async () => {
		const session = new StringSession(config.sessionString)

		const client = new TelegramClient(session, config.apiId, config.apiHash, {
			connectionRetries: Infinity,
			autoReconnect: true,
		})
		client.setLogLevel(LogLevel.NONE)
		client.onError = async (error) => {
			if (isTransientTelegramError(error)) return
			console.error(`[telegram-userbot] Client error (${key}): ${String(error)}`)
		}

		await client.connect()
		console.log(`[telegram-userbot] Connected to Telegram (${key})`)

		clients.set(key, client)
		return client
	})()

	pendingClients.set(key, connectPromise)
	try {
		return await connectPromise
	} finally {
		pendingClients.delete(key)
	}
}

export async function disconnectClient(accountId?: string): Promise<void> {
	const key = normalizeAccountId(accountId)
	const client = clients.get(key)
	if (!client) return

	await disconnectClientInstance(client, accountId)
}

export async function disconnectClientInstance(
	client: TelegramClient,
	accountId?: string,
): Promise<void> {
	const key = normalizeAccountId(accountId)
	if (clients.get(key) === client) {
		clients.delete(key)
	}

	if (client.connected) {
		await client.disconnect()
		console.log(`[telegram-userbot] Disconnected from Telegram (${key})`)
	}
}

export async function disconnectAllClients(): Promise<void> {
	const accountIds = [...clients.keys()]
	await Promise.all(accountIds.map(async (accountId) => await disconnectClient(accountId)))
}

export function getClient(accountId?: string): TelegramClient | null {
	return clients.get(normalizeAccountId(accountId)) ?? null
}
