export interface GroupConfig {
	requireMention?: boolean
	enabled?: boolean
}

export interface PluginConfig {
	apiId: number
	apiHash: string
	sessionString: string
	allowFrom: string[]
	denyFrom: string[]
	replyDelaySec: number
	groups: Record<string, GroupConfig>
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
	return config.groups[chatId] || config.groups["*"] || {}
}
