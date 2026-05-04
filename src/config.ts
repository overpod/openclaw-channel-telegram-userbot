export interface GroupConfig {
	requireMention?: boolean
	enabled?: boolean
	systemPrompt?: string
}

export interface ConversationsConfig {
	/** Max messages to keep per chat (default: 20) */
	maxMessages?: number
	/** Data directory for persistence */
	dataDir?: string
	/** System prompt per chat ID */
	systemPrompts?: Record<string, string>
	/** Default system prompt for all chats */
	defaultSystemPrompt?: string
}

export interface PluginConfig {
	apiId: number
	apiHash: string
	sessionString: string
	allowFrom: string[]
	denyFrom: string[]
	replyDelaySec: number
	groups: Record<string, GroupConfig>
	conversations: ConversationsConfig
}

export function resolveConfig(raw: Record<string, any>): PluginConfig {
	return {
		apiId: Number(raw.apiId),
		apiHash: String(raw.apiHash || ""),
		sessionString: String(raw.sessionString || ""),
		allowFrom: Array.isArray(raw.allowFrom) ? raw.allowFrom : ["*"],
		denyFrom: Array.isArray(raw.denyFrom) ? raw.denyFrom : [],
		replyDelaySec: Number(raw.replyDelaySec ?? 2),
		groups: (raw.groups as Record<string, GroupConfig>) || {},
		conversations: (raw.conversations as ConversationsConfig) || {},
	}
}

export function isChatAllowed(config: PluginConfig, chatId: string): boolean {
	// Deny list takes priority
	if (config.denyFrom.includes(chatId)) return false
	// Allow all
	if (config.allowFrom.includes("*")) return true
	// Explicit allow
	return config.allowFrom.includes(chatId)
}

export function getGroupConfig(config: PluginConfig, chatId: string): GroupConfig {
	const wildcard = config.groups["*"] || {}
	const specific = config.groups[chatId] || {}
	return { ...wildcard, ...specific }
}

function normalizePrompt(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : undefined
}

export function resolveChatSystemPrompt(
	config: PluginConfig,
	chatId: string,
	isGroup: boolean,
): string | undefined {
	const conversationPrompt =
		normalizePrompt(config.conversations.systemPrompts?.[chatId]) ||
		normalizePrompt(config.conversations.defaultSystemPrompt)
	const groupPrompt = isGroup
		? normalizePrompt(getGroupConfig(config, chatId).systemPrompt)
		: undefined
	return [conversationPrompt, groupPrompt].filter(Boolean).join("\n\n") || undefined
}
