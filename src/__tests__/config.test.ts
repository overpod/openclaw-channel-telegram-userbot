import { describe, expect, it } from "bun:test"
import { getGroupConfig, isChatAllowed, resolveChatSystemPrompt, resolveConfig } from "../config.js"

describe("config", () => {
	const baseConfig = resolveConfig({
		apiId: 123,
		apiHash: "abc",
		sessionString: "test",
	})

	it("should resolve defaults", () => {
		expect(baseConfig.allowFrom).toEqual(["*"])
		expect(baseConfig.denyFrom).toEqual([])
		expect(baseConfig.replyDelaySec).toBe(2)
		expect(baseConfig.groups).toEqual({})
	})

	it("should allow all chats by default", () => {
		expect(isChatAllowed(baseConfig, "12345")).toBe(true)
	})

	it("should deny chats in denyFrom", () => {
		const config = resolveConfig({
			...baseConfig,
			denyFrom: ["99999"],
		})
		expect(isChatAllowed(config, "99999")).toBe(false)
		expect(isChatAllowed(config, "12345")).toBe(true)
	})

	it("should restrict to allowFrom when not wildcard", () => {
		const config = resolveConfig({
			...baseConfig,
			allowFrom: ["111", "222"],
		})
		expect(isChatAllowed(config, "111")).toBe(true)
		expect(isChatAllowed(config, "333")).toBe(false)
	})

	it("should denyFrom override allowFrom", () => {
		const config = resolveConfig({
			...baseConfig,
			allowFrom: ["111"],
			denyFrom: ["111"],
		})
		expect(isChatAllowed(config, "111")).toBe(false)
	})

	it("should return group config", () => {
		const config = resolveConfig({
			...baseConfig,
			groups: { "123": { requireMention: true, enabled: true } },
		})
		expect(getGroupConfig(config, "123")).toEqual({ requireMention: true, enabled: true })
		expect(getGroupConfig(config, "999")).toEqual({})
	})

	it("should fallback to wildcard group config", () => {
		const config = resolveConfig({
			...baseConfig,
			groups: { "*": { requireMention: true } },
		})
		expect(getGroupConfig(config, "anything")).toEqual({ requireMention: true })
	})

	it("should merge wildcard and specific group config", () => {
		const config = resolveConfig({
			...baseConfig,
			groups: {
				"*": { requireMention: true, enabled: true, systemPrompt: "Global group prompt" },
				"123": { enabled: false },
			},
		})
		expect(getGroupConfig(config, "123")).toEqual({
			requireMention: true,
			enabled: false,
			systemPrompt: "Global group prompt",
		})
	})

	it("should resolve default chat system prompt", () => {
		const config = resolveConfig({
			...baseConfig,
			conversations: { defaultSystemPrompt: "You are helpful" },
		})
		expect(resolveChatSystemPrompt(config, "123", false)).toBe("You are helpful")
	})

	it("should prefer per-chat prompt over default", () => {
		const config = resolveConfig({
			...baseConfig,
			conversations: {
				defaultSystemPrompt: "You are helpful",
				systemPrompts: { "123": "You are terse" },
			},
		})
		expect(resolveChatSystemPrompt(config, "123", false)).toBe("You are terse")
	})

	it("should append group prompt to conversation prompt for groups", () => {
		const config = resolveConfig({
			...baseConfig,
			conversations: { defaultSystemPrompt: "You are helpful" },
			groups: { "123": { systemPrompt: "Reply like a regular member." } },
		})
		expect(resolveChatSystemPrompt(config, "123", true)).toBe(
			"You are helpful\n\nReply like a regular member.",
		)
	})

	it("should ignore blank prompts", () => {
		const config = resolveConfig({
			...baseConfig,
			conversations: {
				defaultSystemPrompt: "   ",
				systemPrompts: { "123": "\n\t" },
			},
			groups: { "123": { systemPrompt: "  " } },
		})
		expect(resolveChatSystemPrompt(config, "123", true)).toBeUndefined()
	})
})
