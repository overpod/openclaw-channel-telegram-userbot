import { createTelegramClient, disconnectClient, getClient } from "./client.js"
import { resolveConfig } from "./config.js"
import { decryptSession, isEncryptedSession } from "./crypto.js"

import { sendTextReply, setupInboundHandler } from "./handler.js"

interface ChannelPluginAPI {
	config: Record<string, any>
	dispatchReply: (
		sessionId: string,
		envelope: { sender: string; text: string; metadata?: any },
	) => void
	onOutbound: (
		handler: (sessionId: string, text: string, metadata?: any) => void | Promise<void>,
	) => void
	onShutdown: (handler: () => void | Promise<void>) => void
}

export default function register(api: ChannelPluginAPI): void {
	const config = resolveConfig(api.config)

	// Validate required config
	if (!config.apiId || !config.apiHash || !config.sessionString) {
		console.error(
			"[telegram-userbot] Missing required config: apiId, apiHash, sessionString. Run: bun run src/auth.ts",
		)
		return
	}
	// Boot async
	;(async () => {
		// Decrypt session if encrypted
		let sessionString = config.sessionString
		if (isEncryptedSession(sessionString)) {
			try {
				sessionString = await decryptSession(sessionString)
				config.sessionString = sessionString
			} catch (err: any) {
				console.error(`[telegram-userbot] ${err.message}`)
				return
			}
		}

		const client = await createTelegramClient(config)

		// Handle inbound messages from Telegram → OpenClaw
		setupInboundHandler(client, config, (sessionId: string, message: InboundMessage) => {
			api.dispatchReply(sessionId, {
				sender: message.senderName,
				text: message.text,
				metadata: {
					chatId: message.chatId,
					senderId: message.senderId,
					messageId: message.messageId,
					isGroup: message.isGroup,
					replyToMessageId: message.replyToMessageId,
				},
			})
		})

		// Handle outbound messages from OpenClaw → Telegram
		api.onOutbound(async (sessionId: string, text: string, metadata?: any) => {
			const telegramClient = getClient()
			if (!telegramClient) return

			// Extract chatId from sessionId: telegram-userbot:dm:123 or telegram-userbot:group:456
			const parts = sessionId.split(":")
			const chatId = parts[2]
			if (!chatId) return

			await sendTextReply(telegramClient, config, chatId, text, metadata?.replyToMessageId)
		})

		// Cleanup on shutdown
		api.onShutdown(async () => {
			await disconnectClient()
		})

		console.error("[telegram-userbot] Plugin ready")
	})()
}

export const id = "telegram-userbot"
export const name = "Telegram Userbot"
export const description = "Connect your personal Telegram account to OpenClaw via MTProto"
