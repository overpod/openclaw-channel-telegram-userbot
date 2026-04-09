import type { TelegramClient } from "telegram"
import { Api } from "telegram"
import type { PluginConfig } from "./config.js"
import { getGroupConfig, isChatAllowed } from "./config.js"

export interface MediaAttachment {
	type: "photo" | "video" | "document" | "voice" | "audio" | "sticker" | "animation"
	/** File ID for downloading */
	fileId: string
	/** MIME type if available */
	mimeType?: string
	/** File name if available */
	fileName?: string
	/** File size in bytes */
	fileSize?: number
	/** Duration in seconds (voice, video, audio) */
	duration?: number
}

export interface InboundMessage {
	chatId: string
	senderId: string
	senderName: string
	text: string
	isGroup: boolean
	isMentioned: boolean
	messageId: number
	replyToMessageId?: number
	/** Media attachments */
	media?: MediaAttachment
	/** Quoted message text (when replying to a message) */
	replyContext?: string
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
		if (!message) return

		// Must have text or media
		const hasText = !!message.message
		const hasMedia = !!message.media
		if (!hasText && !hasMedia) return

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

		// Extract media attachment
		const media = extractMedia(message)

		// Get reply context (quoted message text)
		let replyContext: string | undefined
		if (message.replyTo?.replyToMsgId) {
			try {
				const replies = await client.getMessages(chatId, {
					ids: [message.replyTo.replyToMsgId],
				})
				if (replies?.[0]?.message) {
					replyContext = replies[0].message
				}
			} catch {}
		}

		const sessionId = isGroup ? `telegram-userbot:group:${chatId}` : `telegram-userbot:dm:${chatId}`

		const inbound: InboundMessage = {
			chatId,
			senderId,
			senderName,
			text: message.message || "",
			isGroup,
			isMentioned,
			messageId: message.id,
			replyToMessageId: message.replyTo?.replyToMsgId,
			media,
			replyContext,
		}

		dispatch(sessionId, inbound)
	})
}

/** Extract media info from a Telegram message */
function extractMedia(message: Api.Message): MediaAttachment | undefined {
	const m = message.media
	if (!m) return undefined

	if (m instanceof Api.MessageMediaPhoto && m.photo instanceof Api.Photo) {
		return {
			type: "photo",
			fileId: m.photo.id.toString(),
			fileSize: m.photo.sizes?.reduce((max: number, s: any) => Math.max(max, s.size || 0), 0),
		}
	}

	if (m instanceof Api.MessageMediaDocument && m.document instanceof Api.Document) {
		const doc = m.document
		const mimeType = doc.mimeType || undefined

		// Determine type from attributes and mime
		let type: MediaAttachment["type"] = "document"
		let duration: number | undefined
		let fileName: string | undefined

		for (const attr of doc.attributes) {
			if (attr instanceof Api.DocumentAttributeVideo) {
				type = "video"
				duration = attr.duration
			} else if (attr instanceof Api.DocumentAttributeAudio) {
				type = attr.voice ? "voice" : "audio"
				duration = attr.duration
			} else if (attr instanceof Api.DocumentAttributeSticker) {
				type = "sticker"
			} else if (attr instanceof Api.DocumentAttributeAnimated) {
				type = "animation"
			} else if (attr instanceof Api.DocumentAttributeFilename) {
				fileName = attr.fileName
			}
		}

		return {
			type,
			fileId: doc.id.toString(),
			mimeType,
			fileName,
			fileSize: Number(doc.size) || undefined,
			duration,
		}
	}

	return undefined
}

/**
 * Detect intentional Markdown formatting and enable MarkdownV2 parse mode.
 * Only activates when paired markers are found (e.g. *bold*, _italic_, `code`).
 * Returns parseMode "md2" only when formatting is detected, to avoid
 * MarkdownV2 parsing errors on plain text with special characters.
 */
export function detectMarkdown(text: string): "md2" | undefined {
	// Match paired formatting markers only
	const hasBold = /\*[^*]+\*/.test(text)
	const hasItalic = /_[^_]+_/.test(text)
	const hasCode = /`[^`]+`/.test(text)
	const hasStrike = /~[^~]+~/.test(text)
	const hasSpoiler = /\|\|[^|]+\|\|/.test(text)
	return hasBold || hasItalic || hasCode || hasStrike || hasSpoiler ? "md2" : undefined
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

	const parseMode = detectMarkdown(text)

	await client.sendMessage(chatId, {
		message: text,
		parseMode,
		replyTo: replyToMessageId,
	})
}

export async function sendMediaReply(
	client: TelegramClient,
	config: PluginConfig,
	chatId: string,
	filePath: string,
	caption?: string,
	replyToMessageId?: number,
): Promise<void> {
	// Human-like delay
	if (config.replyDelaySec > 0) {
		try {
			await client.invoke(
				new Api.messages.SetTyping({
					peer: chatId,
					action: new Api.SendMessageUploadDocumentAction({ progress: 0 }),
				}),
			)
		} catch {}
		await sleep(config.replyDelaySec * 1000)
	}

	const parseMode = caption ? detectMarkdown(caption) : undefined

	await client.sendFile(chatId, {
		file: filePath,
		caption,
		parseMode,
		replyTo: replyToMessageId,
	})
}

/**
 * Download media from a message to a local path.
 * Returns the actual output path on success, or undefined on failure.
 * The returned path may differ from outputPath if the library appends an extension.
 */
export async function downloadMedia(
	client: TelegramClient,
	chatId: string,
	messageId: number,
	outputPath: string,
): Promise<string | undefined> {
	try {
		const messages = await client.getMessages(chatId, { ids: [messageId] })
		const msg = messages?.[0]
		if (!msg?.media) return undefined

		const result = await client.downloadMedia(msg, { outputFile: outputPath })
		if (!result) return undefined
		// GramJS may return a Buffer or the path string
		return typeof result === "string" ? result : outputPath
	} catch {
		return undefined
	}
}
