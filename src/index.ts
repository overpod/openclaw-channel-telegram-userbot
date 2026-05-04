import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, extname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
	buildChannelOutboundSessionRoute,
	type ChannelAccountSnapshot,
	type ChannelMessagingAdapter,
	type ChannelOutboundAdapter,
	type ChannelPlugin,
	defineChannelPluginEntry,
	type OpenClawConfig,
	type PluginRuntime,
} from "openclaw/plugin-sdk/core"
import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch"
import { resolvePayloadMediaUrls } from "openclaw/plugin-sdk/reply-payload"
import { Api, type TelegramClient } from "telegram"
import { NewMessage, Raw } from "telegram/events/index.js"
import { UpdateConnectionState } from "telegram/network/index.js"

import {
	createTelegramClient,
	disconnectAllClients,
	disconnectClient,
	disconnectClientInstance,
	getClient,
} from "./client.js"
import {
	getGroupConfig,
	isChatAllowed,
	type PluginConfig,
	resolveChatSystemPrompt,
	resolveConfig,
} from "./config.js"
import { decryptSession, isEncryptedSession } from "./crypto.js"
import {
	downloadMedia,
	type InboundMessage,
	type MediaAttachment,
	sendMediaReply,
	sendTextReply,
} from "./handler.js"

const CHANNEL_ID = "telegram-userbot"
const CHANNEL_LABEL = "Telegram Userbot"
const DEFAULT_ACCOUNT_ID = "default"
const DEFAULT_MEDIA_DIR = join(homedir(), ".openclaw", "telegram-userbot", "media")

const TELEGRAM_USERBOT_CONFIG_SCHEMA = {
	schema: {
		type: "object",
		additionalProperties: true,
		properties: {
			enabled: { type: "boolean" },
			apiId: { type: "number" },
			apiHash: { type: "string" },
			sessionString: { type: "string" },
			allowFrom: {
				type: "array",
				items: { type: "string" },
			},
			denyFrom: {
				type: "array",
				items: { type: "string" },
			},
			replyDelaySec: { type: "number" },
			groups: {
				type: "object",
				additionalProperties: true,
			},
			conversations: {
				type: "object",
				additionalProperties: true,
			},
			accounts: {
				type: "object",
				additionalProperties: true,
			},
		},
	},
} as const

type TelegramUserbotAccount = {
	accountId: string
	enabled: boolean
	configured: boolean
	config: PluginConfig
}

type RuntimeAccountState = {
	connectionEvent?: Raw
	connectionHandler?: (event: unknown) => Promise<void>
	messageEvent?: NewMessage
	messageHandler?: (event: unknown) => Promise<void>
}

const runtimeAccountState = new Map<string, RuntimeAccountState>()

let pluginRuntime: PluginRuntime | null = null

function setTelegramUserbotRuntime(runtime: PluginRuntime): void {
	pluginRuntime = runtime
}

function getRuntime(): PluginRuntime {
	if (!pluginRuntime) {
		throw new Error("[telegram-userbot] OpenClaw plugin runtime is not initialized")
	}

	return pluginRuntime
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
	return value as Record<string, unknown>
}

function normalizeAccountId(accountId?: string | null): string {
	return accountId?.trim() || DEFAULT_ACCOUNT_ID
}

function getChannelSection(cfg: OpenClawConfig): Record<string, unknown> {
	const root = asRecord(cfg)
	const channels = asRecord(root?.channels)
	return asRecord(channels?.[CHANNEL_ID]) ?? {}
}

function getAccountSection(
	section: Record<string, unknown>,
	accountId: string,
): Record<string, unknown> | undefined {
	const accounts = asRecord(section.accounts)
	return asRecord(accounts?.[accountId])
}

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
	const section = getChannelSection(cfg)
	const accounts = asRecord(section.accounts)
	const accountIds = accounts ? Object.keys(accounts).filter(Boolean) : []
	if (accountIds.length > 0) return accountIds
	return Object.keys(section).length > 0 ? [DEFAULT_ACCOUNT_ID] : []
}

function resolveDefaultAccountId(cfg: OpenClawConfig): string {
	return listConfiguredAccountIds(cfg)[0] ?? DEFAULT_ACCOUNT_ID
}

function resolveRawAccountConfig(
	cfg: OpenClawConfig,
	accountId?: string | null,
): {
	accountId: string
	raw: Record<string, unknown>
} {
	const section = getChannelSection(cfg)
	const preferredAccountId = normalizeAccountId(accountId)
	const resolvedAccountId =
		preferredAccountId === DEFAULT_ACCOUNT_ID &&
		getAccountSection(section, resolveDefaultAccountId(cfg))
			? resolveDefaultAccountId(cfg)
			: preferredAccountId
	const accountSection = getAccountSection(section, resolvedAccountId)
	const raw = { ...section, ...accountSection }
	delete raw.accounts
	return {
		accountId: resolvedAccountId,
		raw,
	}
}

function isConfiguredAccount(config: PluginConfig): boolean {
	return (
		Number.isFinite(config.apiId) &&
		config.apiId > 0 &&
		config.apiHash.trim().length > 0 &&
		config.sessionString.trim().length > 0
	)
}

function resolveTelegramUserbotAccount(
	cfg: OpenClawConfig,
	accountId?: string | null,
): TelegramUserbotAccount {
	const { accountId: resolvedAccountId, raw } = resolveRawAccountConfig(cfg, accountId)
	const config = resolveConfig(raw)
	return {
		accountId: resolvedAccountId,
		enabled: raw.enabled !== false,
		configured: isConfiguredAccount(config),
		config,
	}
}

function cloneConfig(cfg: OpenClawConfig): OpenClawConfig {
	return structuredClone(cfg)
}

function ensureChannelSection(cfg: OpenClawConfig): Record<string, unknown> {
	const root = cfg as Record<string, unknown>
	const channels = (asRecord(root.channels) ?? {}) as Record<string, unknown>
	root.channels = channels
	const section = (asRecord(channels[CHANNEL_ID]) ?? {}) as Record<string, unknown>
	channels[CHANNEL_ID] = section
	return section
}

function formatAllowFrom(values: Array<string | number>): string[] {
	return values.map((value) => String(value).trim()).filter(Boolean)
}

function parseNumericId(value?: string | number | null): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value
	if (typeof value !== "string") return undefined
	const parsed = Number(value.trim())
	return Number.isFinite(parsed) ? parsed : undefined
}

function normalizeDigits(value: string): string {
	return value.replace(/\D/g, "")
}

function mapTelegramSendError(error: unknown, target: string): Error {
	const message = String(error)
	if (!message.includes("Could not find the input entity")) {
		return error instanceof Error ? error : new Error(message)
	}

	const digits = normalizeDigits(target)
	if (digits.length >= 7) {
		return new Error(
			`[telegram-userbot] Telegram could not resolve "${target}" as a known chat. Use a Telegram @username, an existing peer/chat id, or a full phone number that is already saved in your Telegram contacts.`,
		)
	}

	return new Error(
		`[telegram-userbot] Telegram could not resolve "${target}" as a known chat. Use a Telegram @username or an existing peer/chat id.`,
	)
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return

	await new Promise<void>((resolve) => {
		const handleAbort = (): void => resolve()
		if (signal.aborted) {
			resolve()
			return
		}
		signal.addEventListener("abort", handleAbort, { once: true })
	})
}

function formatTelegramTarget(chatId: string, chatType: "direct" | "group"): string {
	return `${chatType === "group" ? "group" : "user"}:${chatId}`
}

function parseTelegramTarget(raw: string): {
	chatId: string
	chatType: "direct" | "group"
	target: string
} | null {
	let value = raw.trim()
	if (!value) return null

	value = value
		.replace(/^telegram-userbot:/i, "")
		.replace(/^telegram:/i, "")
		.trim()
	if (!value) return null

	let chatType: "direct" | "group" = "direct"
	const lower = value.toLowerCase()

	if (
		lower.startsWith("group:") ||
		lower.startsWith("g:") ||
		lower.startsWith("channel:") ||
		lower.startsWith("chat:")
	) {
		chatType = "group"
		value = value.slice(value.indexOf(":") + 1).trim()
	} else if (lower.startsWith("user:") || lower.startsWith("u:") || lower.startsWith("dm:")) {
		chatType = "direct"
		value = value.slice(value.indexOf(":") + 1).trim()
	} else if (value.startsWith("-")) {
		chatType = "group"
	}

	if (!value) return null

	return {
		chatId: value,
		chatType,
		target: formatTelegramTarget(value, chatType),
	}
}

function buildMediaDescription(media?: MediaAttachment): string | undefined {
	if (!media) return undefined
	const detailParts = [
		media.fileName,
		typeof media.duration === "number" ? `${media.duration}s` : undefined,
	].filter(Boolean)
	return detailParts.length > 0 ? `[${media.type}: ${detailParts.join(", ")}]` : `[${media.type}]`
}

function buildInboundBody(message: InboundMessage): string {
	const mediaDescription = buildMediaDescription(message.media)
	if (mediaDescription && message.text) return `${mediaDescription} ${message.text}`.trim()
	return mediaDescription ?? message.text ?? ""
}

function resolveMessageTimestamp(message: Api.Message): number {
	const rawDate = message.date as unknown
	if (rawDate instanceof Date) return rawDate.getTime()
	if (typeof rawDate === "number" && Number.isFinite(rawDate)) {
		return rawDate < 1e12 ? rawDate * 1000 : rawDate
	}
	return Date.now()
}

async function resolveSenderName(client: TelegramClient, senderId: string): Promise<string> {
	try {
		const entity = await client.getEntity(senderId)
		if ("firstName" in entity) {
			return [entity.firstName, entity.lastName].filter(Boolean).join(" ") || senderId
		}
		if ("title" in entity) return entity.title || senderId
	} catch {}

	return senderId
}

async function resolveChatTitle(
	client: TelegramClient,
	peer: Api.TypePeer | undefined,
): Promise<string | undefined> {
	if (!peer) return undefined

	try {
		const entity = await client.getEntity(peer)
		if ("title" in entity && typeof entity.title === "string" && entity.title.trim()) {
			return entity.title
		}
	} catch {}

	return undefined
}

async function resolveReplyContext(
	client: TelegramClient,
	chatId: string,
	replyToMessageId?: number,
): Promise<string | undefined> {
	if (!replyToMessageId) return undefined

	try {
		const replies = await client.getMessages(chatId, { ids: [replyToMessageId] })
		if (replies?.[0]?.message) return replies[0].message
	} catch {}

	return undefined
}

function sanitizePathSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "_")
}

function resolveMediaOutputDir(config: PluginConfig, accountId: string, chatId: string): string {
	const configuredDir = config.conversations.dataDir?.trim()
	const rootDir = configuredDir ? join(configuredDir, "media") : DEFAULT_MEDIA_DIR
	return join(rootDir, sanitizePathSegment(accountId), sanitizePathSegment(chatId))
}

async function resolveInboundMediaContext(params: {
	client: TelegramClient
	accountId: string
	config: PluginConfig
	message: InboundMessage
}): Promise<Record<string, unknown>> {
	if (!params.message.media) return {}

	const outputDir = resolveMediaOutputDir(params.config, params.accountId, params.message.chatId)
	await mkdir(outputDir, { recursive: true })
	const outputPath = join(outputDir, String(params.message.messageId))
	const savedPath = await downloadMedia(
		params.client,
		params.message.chatId,
		params.message.messageId,
		outputPath,
	)
	if (!savedPath) return {}

	const mediaType = params.message.media.mimeType || params.message.media.type

	return {
		MediaPath: savedPath,
		MediaPaths: [savedPath],
		MediaType: mediaType,
		MediaTypes: [mediaType],
	}
}

async function materializeMediaFile(params: {
	mediaUrl: string
	mediaReadFile?: (filePath: string) => Promise<Buffer>
}): Promise<{ filePath: string; cleanup?: () => Promise<void> }> {
	if (params.mediaUrl.startsWith("file://")) {
		return { filePath: fileURLToPath(params.mediaUrl) }
	}

	if (!/^https?:\/\//i.test(params.mediaUrl) && !params.mediaReadFile) {
		return { filePath: params.mediaUrl }
	}

	const buffer = params.mediaReadFile
		? await params.mediaReadFile(params.mediaUrl)
		: Buffer.from(await (await fetch(params.mediaUrl)).arrayBuffer())
	const tempDir = await mkdtemp(join(tmpdir(), "telegram-userbot-"))
	const ext = extname(params.mediaUrl) || ".bin"
	const filePath = join(tempDir, `${basename(params.mediaUrl, ext) || "attachment"}${ext}`)
	await writeFile(filePath, buffer)

	return {
		filePath,
		cleanup: async () => {
			await rm(tempDir, { recursive: true, force: true })
		},
	}
}

async function withTelegramClient<T>(params: {
	cfg: OpenClawConfig
	accountId?: string | null
	run: (client: TelegramClient, account: TelegramUserbotAccount, config: PluginConfig) => Promise<T>
}): Promise<T> {
	const account = resolveTelegramUserbotAccount(params.cfg, params.accountId)
	let client = getClient(account.accountId)
	let ephemeralClient = false
	let config = account.config

	if (!client) {
		let sessionString = config.sessionString
		if (isEncryptedSession(sessionString)) {
			sessionString = await decryptSession(sessionString)
		}

		config = {
			...config,
			sessionString,
		}
		client = await createTelegramClient(config, account.accountId)
		ephemeralClient = true
	}

	try {
		return await params.run(client, account, config)
	} finally {
		if (ephemeralClient) {
			await disconnectClientInstance(client, account.accountId)
		}
	}
}

async function sendTelegramText(ctx: {
	cfg: OpenClawConfig
	accountId?: string | null
	to: string
	text: string
	replyToId?: string | null
}): Promise<{ channel: typeof CHANNEL_ID; messageId: string; chatId: string; timestamp: number }> {
	const target = parseTelegramTarget(ctx.to)
	if (!target) throw new Error(`[telegram-userbot] Invalid Telegram target: ${ctx.to}`)

	return await withTelegramClient({
		cfg: ctx.cfg,
		accountId: ctx.accountId,
		run: async (client, _account, config) => {
			let sent: Api.Message
			try {
				sent = await sendTextReply(
					client,
					config,
					target.chatId,
					ctx.text,
					parseNumericId(ctx.replyToId),
				)
			} catch (error) {
				throw mapTelegramSendError(error, ctx.to)
			}

			return {
				channel: CHANNEL_ID,
				messageId: String(sent.id),
				chatId: target.chatId,
				timestamp: Date.now(),
			}
		},
	})
}

async function sendTelegramMedia(ctx: {
	cfg: OpenClawConfig
	accountId?: string | null
	to: string
	text: string
	mediaUrl: string
	replyToId?: string | null
	mediaReadFile?: (filePath: string) => Promise<Buffer>
}): Promise<{ channel: typeof CHANNEL_ID; messageId: string; chatId: string; timestamp: number }> {
	const target = parseTelegramTarget(ctx.to)
	if (!target) throw new Error(`[telegram-userbot] Invalid Telegram target: ${ctx.to}`)

	const materialized = await materializeMediaFile({
		mediaUrl: ctx.mediaUrl,
		mediaReadFile: ctx.mediaReadFile,
	})

	try {
		return await withTelegramClient({
			cfg: ctx.cfg,
			accountId: ctx.accountId,
			run: async (client, _account, config) => {
				let sent: Api.Message
				try {
					sent = await sendMediaReply(
						client,
						config,
						target.chatId,
						materialized.filePath,
						ctx.text || undefined,
						parseNumericId(ctx.replyToId),
					)
				} catch (error) {
					throw mapTelegramSendError(error, ctx.to)
				}

				return {
					channel: CHANNEL_ID,
					messageId: String(sent.id),
					chatId: target.chatId,
					timestamp: Date.now(),
				}
			},
		})
	} finally {
		await materialized.cleanup?.()
	}
}

const messagingAdapter: ChannelMessagingAdapter = {
	normalizeTarget(raw) {
		return parseTelegramTarget(raw)?.target
	},
	parseExplicitTarget({ raw }) {
		const target = parseTelegramTarget(raw)
		if (!target) return null
		return {
			to: target.target,
			chatType: target.chatType,
		}
	},
	inferTargetChatType({ to }) {
		return parseTelegramTarget(to)?.chatType
	},
	resolveOutboundSessionRoute(params) {
		const target = parseTelegramTarget(params.resolvedTarget?.to ?? params.target)
		if (!target) return null
		const resolvedAccountId = resolveTelegramUserbotAccount(params.cfg, params.accountId).accountId

		return buildChannelOutboundSessionRoute({
			cfg: params.cfg,
			agentId: params.agentId,
			channel: CHANNEL_ID,
			accountId: resolvedAccountId,
			peer: {
				kind: target.chatType === "direct" ? "direct" : "group",
				id: target.chatId,
			},
			chatType: target.chatType,
			from: target.target,
			to: target.target,
			...(params.threadId != null ? { threadId: params.threadId } : {}),
		})
	},
}

const outboundAdapter: ChannelOutboundAdapter = {
	deliveryMode: "direct",
	textChunkLimit: 4000,
	async sendText(ctx) {
		return await sendTelegramText(ctx)
	},
	async sendMedia(ctx) {
		if (!ctx.mediaUrl) {
			throw new Error("[telegram-userbot] sendMedia called without mediaUrl")
		}

		return await sendTelegramMedia({
			cfg: ctx.cfg,
			accountId: ctx.accountId,
			to: ctx.to,
			text: ctx.text,
			mediaUrl: ctx.mediaUrl,
			replyToId: ctx.replyToId,
			mediaReadFile: ctx.mediaReadFile,
		})
	},
	async sendPayload(ctx) {
		const mediaUrls = resolvePayloadMediaUrls(ctx.payload)
		if (mediaUrls.length === 0) {
			return await sendTelegramText(ctx)
		}

		let lastResult:
			| { channel: typeof CHANNEL_ID; messageId: string; chatId: string; timestamp: number }
			| undefined
		const caption = ctx.text

		for (const [index, mediaUrl] of mediaUrls.entries()) {
			lastResult = await sendTelegramMedia({
				...ctx,
				text: index === 0 ? caption : "",
				mediaUrl,
			})
		}

		return (
			lastResult ?? {
				channel: CHANNEL_ID,
				messageId: "noop",
			}
		)
	},
}

const gatewayAdapter: NonNullable<ChannelPlugin<TelegramUserbotAccount>["gateway"]> = {
	async startAccount(ctx) {
		if (!ctx.account.enabled) {
			ctx.log?.info?.(`[telegram-userbot] Account ${ctx.account.accountId} is disabled`)
			return
		}

		if (!ctx.account.configured) {
			ctx.log?.warn?.(
				`[telegram-userbot] Account ${ctx.account.accountId} is not configured. Missing apiId/apiHash/sessionString.`,
			)
			return
		}

		let sessionString = ctx.account.config.sessionString
		if (isEncryptedSession(sessionString)) {
			sessionString = await decryptSession(sessionString)
		}

		const config = {
			...ctx.account.config,
			sessionString,
		}

		const client = await createTelegramClient(config, ctx.account.accountId)
		const runtime = getRuntime()
		const accountState = runtimeAccountState.get(ctx.account.accountId) ?? {}
		const accountStatusBase = {
			accountId: ctx.account.accountId,
			configured: true,
			enabled: true,
			running: true,
		}

		accountState.connectionEvent = new Raw({ types: [UpdateConnectionState] })
		accountState.connectionHandler = async (event: unknown) => {
			if (!(event instanceof UpdateConnectionState)) return
			if (ctx.abortSignal.aborted) return

			const now = Date.now()
			const current = ctx.getStatus()
			if (event.state === UpdateConnectionState.connected) {
				ctx.setStatus({
					...current,
					...accountStatusBase,
					connected: true,
					lastConnectedAt: now,
					lastDisconnect: null,
					lastEventAt: now,
					healthState: "healthy",
				})
				return
			}

			const error =
				event.state === UpdateConnectionState.broken ? "connection broken" : "connection lost"
			ctx.log?.warn?.(
				`[telegram-userbot] Telegram connection degraded (${ctx.account.accountId}): ${error}`,
			)
			ctx.setStatus({
				...current,
				...accountStatusBase,
				connected: false,
				lastDisconnect: {
					at: now,
					error,
				},
				lastEventAt: now,
				healthState: "degraded",
			})
		}

		accountState.messageEvent = new NewMessage({})
		accountState.messageHandler = async (event: unknown) => {
			try {
				const message = (event as { message?: Api.Message }).message
				if (!(message instanceof Api.Message)) return
				if (message.out) return

				const chatId = message.chatId?.toString() || message.peerId?.toString() || ""
				if (!chatId) return

				const media = message.media ? extractInboundMedia(message) : undefined
				const hasText = typeof message.message === "string" && message.message.length > 0
				if (!hasText && !media) return

				const senderId = message.senderId?.toString()
				if (!senderId) return
				if (!isChatAllowed(config, chatId)) return

				const isGroup =
					message.peerId instanceof Api.PeerChat || message.peerId instanceof Api.PeerChannel
				const groupConfig = isGroup ? getGroupConfig(config, chatId) : {}
				const isMentioned = message.mentioned || false
				if (isGroup && groupConfig.enabled === false) return
				if (isGroup && groupConfig.requireMention && !isMentioned) return

				const senderName = await resolveSenderName(client, senderId)
				const chatTitle = isGroup ? await resolveChatTitle(client, message.peerId) : undefined
				const replyContext = await resolveReplyContext(
					client,
					chatId,
					message.replyTo?.replyToMsgId,
				)

				const inboundMessage: InboundMessage = {
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

				const route = runtime.channel.routing.resolveAgentRoute({
					cfg: ctx.cfg,
					channel: CHANNEL_ID,
					accountId: ctx.account.accountId,
					peer: {
						kind: isGroup ? "group" : "direct",
						id: chatId,
					},
				})
				const storePath = runtime.channel.session.resolveStorePath(ctx.cfg.session?.store, {
					agentId: route.agentId,
				})
				const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
					storePath,
					sessionKey: route.sessionKey,
				})
				const bodyForAgent = buildInboundBody(inboundMessage)
				const systemPrompt = resolveChatSystemPrompt(config, chatId, isGroup)
				const timestamp = resolveMessageTimestamp(message)
				const conversationLabel = isGroup
					? chatTitle || `group:${chatId}`
					: senderName || `user:${senderId}`
				const target = formatTelegramTarget(chatId, isGroup ? "group" : "direct")
				const mediaContext = await resolveInboundMediaContext({
					client,
					accountId: ctx.account.accountId,
					config,
					message: inboundMessage,
				})

				const body = runtime.channel.reply.formatAgentEnvelope({
					channel: CHANNEL_LABEL,
					from: conversationLabel,
					timestamp,
					previousTimestamp,
					envelope: runtime.channel.reply.resolveEnvelopeFormatOptions(ctx.cfg),
					body: bodyForAgent,
				})

				const ctxPayload = runtime.channel.reply.finalizeInboundContext({
					Body: body,
					BodyForAgent: bodyForAgent,
					RawBody: bodyForAgent,
					CommandBody: bodyForAgent,
					From: `user:${senderId}`,
					To: target,
					SessionKey: route.sessionKey,
					AccountId: route.accountId,
					ChatType: isGroup ? "group" : "direct",
					ConversationLabel: conversationLabel,
					GroupSubject: isGroup ? conversationLabel : undefined,
					GroupSystemPrompt: systemPrompt,
					SenderName: senderName,
					SenderId: senderId,
					ReplyToId: inboundMessage.replyToMessageId
						? String(inboundMessage.replyToMessageId)
						: undefined,
					ReplyToBody: replyContext,
					WasMentioned: isGroup ? isMentioned : undefined,
					MessageSid: String(inboundMessage.messageId),
					MessageSidFull: String(inboundMessage.messageId),
					Timestamp: timestamp,
					Provider: CHANNEL_ID,
					Surface: CHANNEL_ID,
					OriginatingChannel: CHANNEL_ID,
					OriginatingTo: target,
					CommandAuthorized: true,
					...mediaContext,
				})

				await dispatchInboundReplyWithBase({
					cfg: ctx.cfg,
					channel: CHANNEL_ID,
					accountId: ctx.account.accountId,
					route,
					storePath,
					ctxPayload,
					core: runtime,
					deliver: async (payload) => {
						const mediaUrls = payload.mediaUrls?.length
							? payload.mediaUrls
							: payload.mediaUrl
								? [payload.mediaUrl]
								: []

						if (mediaUrls.length > 0) {
							for (const [index, mediaUrl] of mediaUrls.entries()) {
								await sendTelegramMedia({
									cfg: ctx.cfg,
									accountId: ctx.account.accountId,
									to: target,
									text: index === 0 ? (payload.text ?? "") : "",
									mediaUrl,
									replyToId: payload.replyToId ?? ctxPayload.ReplyToId ?? null,
								})
							}
							return
						}

						if (payload.text?.trim()) {
							await sendTelegramText({
								cfg: ctx.cfg,
								accountId: ctx.account.accountId,
								to: target,
								text: payload.text,
								replyToId: payload.replyToId ?? ctxPayload.ReplyToId ?? null,
							})
						}
					},
					onRecordError: (error) => {
						ctx.log?.error?.(`[telegram-userbot] Failed recording session state: ${String(error)}`)
					},
					onDispatchError: (error, info) => {
						ctx.log?.error?.(
							`[telegram-userbot] ${info.kind} reply dispatch failed: ${String(error)}`,
						)
					},
				})

				ctx.setStatus({
					...ctx.getStatus(),
					...accountStatusBase,
					connected: true,
					lastConnectedAt: ctx.getStatus().lastConnectedAt ?? Date.now(),
					lastEventAt: Date.now(),
					lastInboundAt: Date.now(),
					lastMessageAt: Date.now(),
					healthState: "healthy",
				})
			} catch (error) {
				ctx.log?.error?.(`[telegram-userbot] Inbound handler failed: ${String(error)}`)
			}
		}

		client.addEventHandler(accountState.connectionHandler, accountState.connectionEvent)
		client.addEventHandler(accountState.messageHandler, accountState.messageEvent)
		runtimeAccountState.set(ctx.account.accountId, accountState)

		ctx.setStatus({
			...ctx.getStatus(),
			...accountStatusBase,
			connected: true,
			lastConnectedAt: Date.now(),
			lastStartAt: Date.now(),
			healthState: "healthy",
		})

		await waitForAbort(ctx.abortSignal)
	},
	async stopAccount(ctx) {
		const state = runtimeAccountState.get(ctx.account.accountId)
		const client = getClient(ctx.account.accountId)

		if (client && state?.messageHandler && state.messageEvent) {
			client.removeEventHandler(state.messageHandler, state.messageEvent)
		}

		if (client && state?.connectionHandler && state.connectionEvent) {
			client.removeEventHandler(state.connectionHandler, state.connectionEvent)
		}

		runtimeAccountState.delete(ctx.account.accountId)
		await disconnectClient(ctx.account.accountId)

		ctx.setStatus({
			...ctx.getStatus(),
			accountId: ctx.account.accountId,
			running: false,
			connected: false,
			healthState: "stopped",
			lastStopAt: Date.now(),
		})
	},
}

function extractInboundMedia(message: Api.Message): MediaAttachment | undefined {
	const media = message.media
	if (!media) return undefined

	if (media instanceof Api.MessageMediaPhoto && media.photo instanceof Api.Photo) {
		return {
			type: "photo",
			fileId: media.photo.id.toString(),
			fileSize: media.photo.sizes?.reduce((max: number, size: Api.TypePhotoSize) => {
				const currentSize = "size" in size && typeof size.size === "number" ? size.size : max
				return Math.max(max, currentSize)
			}, 0),
		}
	}

	if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
		let type: MediaAttachment["type"] = "document"
		let duration: number | undefined
		let fileName: string | undefined

		for (const attribute of media.document.attributes) {
			if (attribute instanceof Api.DocumentAttributeVideo) {
				type = "video"
				duration = attribute.duration
				continue
			}

			if (attribute instanceof Api.DocumentAttributeAudio) {
				type = attribute.voice ? "voice" : "audio"
				duration = attribute.duration
				continue
			}

			if (attribute instanceof Api.DocumentAttributeSticker) {
				type = "sticker"
				continue
			}

			if (attribute instanceof Api.DocumentAttributeAnimated) {
				type = "animation"
				continue
			}

			if (attribute instanceof Api.DocumentAttributeFilename) {
				fileName = attribute.fileName
			}
		}

		return {
			type,
			fileId: media.document.id.toString(),
			mimeType: media.document.mimeType || undefined,
			fileName,
			fileSize: Number(media.document.size) || undefined,
			duration,
		}
	}

	return undefined
}

const telegramUserbotPlugin: ChannelPlugin<TelegramUserbotAccount> = {
	id: CHANNEL_ID,
	meta: {
		id: CHANNEL_ID,
		label: CHANNEL_LABEL,
		selectionLabel: "Telegram Userbot (MTProto)",
		detailLabel: CHANNEL_LABEL,
		docsPath: "/channels/telegram-userbot",
		docsLabel: "telegram-userbot",
		blurb: "Connect a personal Telegram account through MTProto instead of a Bot API token.",
		markdownCapable: true,
		exposure: {
			configured: true,
			setup: false,
			docs: false,
		},
		showInSetup: false,
	},
	capabilities: {
		chatTypes: ["direct", "group"],
		media: true,
		reply: true,
	},
	reload: {
		configPrefixes: [`channels.${CHANNEL_ID}`],
	},
	configSchema: TELEGRAM_USERBOT_CONFIG_SCHEMA,
	config: {
		listAccountIds: listConfiguredAccountIds,
		resolveAccount: resolveTelegramUserbotAccount,
		defaultAccountId: resolveDefaultAccountId,
		setAccountEnabled({ cfg, accountId, enabled }) {
			const next = cloneConfig(cfg)
			const section = ensureChannelSection(next)
			const normalizedAccountId = normalizeAccountId(accountId)
			if (normalizedAccountId === DEFAULT_ACCOUNT_ID && !asRecord(section.accounts)) {
				section.enabled = enabled
				return next
			}

			const accounts = (asRecord(section.accounts) ?? {}) as Record<string, unknown>
			section.accounts = accounts
			const accountSection = (asRecord(accounts[normalizedAccountId]) ?? {}) as Record<
				string,
				unknown
			>
			accountSection.enabled = enabled
			accounts[normalizedAccountId] = accountSection
			return next
		},
		deleteAccount({ cfg, accountId }) {
			const next = cloneConfig(cfg)
			const root = asRecord(next as unknown)
			const channels = asRecord(root?.channels)
			const section = asRecord(channels?.[CHANNEL_ID])
			if (!channels || !section) return next

			const normalizedAccountId = normalizeAccountId(accountId)
			if (normalizedAccountId === DEFAULT_ACCOUNT_ID && !asRecord(section.accounts)) {
				delete channels[CHANNEL_ID]
				return next
			}

			const accounts = asRecord(section.accounts)
			if (!accounts) return next
			delete accounts[normalizedAccountId]
			if (Object.keys(accounts).length === 0) delete section.accounts
			return next
		},
		isEnabled(account) {
			return account.enabled
		},
		isConfigured(account) {
			return account.configured
		},
		unconfiguredReason(account) {
			return account.configured ? "configured" : "missing apiId, apiHash, or sessionString"
		},
		describeAccount(account): ChannelAccountSnapshot {
			return {
				accountId: account.accountId,
				name: account.accountId === DEFAULT_ACCOUNT_ID ? CHANNEL_LABEL : account.accountId,
				configured: account.configured,
				enabled: account.enabled,
				linked: account.configured,
			}
		},
		resolveAllowFrom({ cfg, accountId }) {
			return resolveTelegramUserbotAccount(cfg, accountId).config.allowFrom
		},
		formatAllowFrom({ allowFrom }) {
			return formatAllowFrom(allowFrom)
		},
		hasConfiguredState({ cfg }) {
			return listConfiguredAccountIds(cfg).some(
				(accountId) => resolveTelegramUserbotAccount(cfg, accountId).configured,
			)
		},
	},
	setup: {
		resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
		resolveBindingAccountId: ({ accountId }) => normalizeAccountId(accountId),
		applyAccountConfig({ cfg }) {
			return cfg
		},
		validateInput() {
			return "Configure channels.telegram-userbot.apiId/apiHash/sessionString manually, then enable the plugin."
		},
	},
	groups: {
		resolveRequireMention({ cfg, accountId, groupId }) {
			if (!groupId) return undefined
			return getGroupConfig(resolveTelegramUserbotAccount(cfg, accountId).config, groupId)
				.requireMention
		},
	},
	messaging: messagingAdapter,
	outbound: outboundAdapter,
	gateway: gatewayAdapter,
}

const entry: ReturnType<typeof defineChannelPluginEntry> = defineChannelPluginEntry({
	id: CHANNEL_ID,
	name: CHANNEL_LABEL,
	description: "Connect your personal Telegram account to OpenClaw via MTProto.",
	plugin: telegramUserbotPlugin,
	configSchema: TELEGRAM_USERBOT_CONFIG_SCHEMA,
	setRuntime: setTelegramUserbotRuntime,
})

export default entry
export { CHANNEL_ID as id, CHANNEL_LABEL as name, setTelegramUserbotRuntime, telegramUserbotPlugin }

process.on("exit", () => {
	void disconnectAllClients()
})
