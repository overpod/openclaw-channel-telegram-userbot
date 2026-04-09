import type { TelegramClient } from "telegram"
import { Api } from "telegram"
import type { PluginConfig } from "./config.js"
import { getGroupConfig, isChatAllowed } from "./config.js"

export interface InboundMessage {
	chatId: string
	senderId: string
	senderName: string
	text: string
	isGroup: boolean
	isMentioned: boolean
	messageId: number
	replyToMessageId?: number
}

export type DispatchReply = (sessionId: string, message: InboundMessage) => void | Promise<void>

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

export function setupInboundHandler(
	client: TelegramClient,
	config: PluginConfig,
	dispatch: DispatchReply,
): void {
	// Client connected

	client.addEventHandler(async (event: any) => {
		const message = event.message as Api.Message | undefined
		if (!message?.message) return

		// Skip our own messages
		const senderId = message.senderId?.toString()
		if (!senderId) return

		const chatId = message.chatId?.toString() || message.peerId?.toString() || ""
		if (!chatId) return

		// Check allowlist/denylist
		if (!isChatAllowed(config, chatId)) return

		const isGroup =
			message.peerId instanceof Api.PeerChat || message.peerId instanceof Api.PeerChannel
		const isMentioned = message.mentioned || false

		// Group filtering
		if (isGroup) {
			const groupConfig = getGroupConfig(config, chatId)
			if (groupConfig.enabled === false) return
			if (groupConfig.requireMention && !isMentioned) return
		}

		// Get sender name
		let senderName = "Unknown"
		try {
			const entity = await client.getEntity(senderId)
			if ("firstName" in entity) {
				senderName = [entity.firstName, entity.lastName].filter(Boolean).join(" ")
			} else if ("title" in entity) {
				senderName = entity.title || "Unknown"
			}
		} catch {}

		const sessionId = isGroup ? `telegram-userbot:group:${chatId}` : `telegram-userbot:dm:${chatId}`

		const inbound: InboundMessage = {
			chatId,
			senderId,
			senderName,
			text: message.message,
			isGroup,
			isMentioned,
			messageId: message.id,
			replyToMessageId: message.replyTo?.replyToMsgId,
		}

		dispatch(sessionId, inbound)
	})
}

export async function sendTextReply(
	client: TelegramClient,
	config: PluginConfig,
	chatId: string,
	text: string,
	replyToMessageId?: number,
): Promise<void> {
	// Human-like delay
	if (config.replyDelaySec > 0) {
		// Send typing action during delay
		try {
			await client.invoke(
				new Api.messages.SetTyping({
					peer: chatId,
					action: new Api.SendMessageTypingAction(),
				}),
			)
		} catch {}
		await sleep(config.replyDelaySec * 1000)
	}

	await client.sendMessage(chatId, {
		message: text,
		replyTo: replyToMessageId,
	})
}

export async function sendMediaReply(
	client: TelegramClient,
	chatId: string,
	filePath: string,
	caption?: string,
): Promise<void> {
	await client.sendFile(chatId, {
		file: filePath,
		caption,
	})
}
