import { describe, expect, test } from "bun:test"
import { detectMarkdown } from "../handler.js"

// Test media description formatting (mirrors logic in index.ts)
function buildMediaDescription(media: {
	type: string
	fileName?: string
	duration?: number
}): string {
	return `[${media.type}${media.fileName ? `: ${media.fileName}` : ""}${media.duration ? `, ${media.duration}s` : ""}]`
}

function buildInboundText(
	text: string,
	replyContext?: string,
	media?: { type: string; fileName?: string; duration?: number },
): string {
	let result = text
	if (replyContext) {
		result = `[Replying to: "${replyContext}"]\n${result}`
	}
	if (media) {
		const mediaDesc = buildMediaDescription(media)
		result = result ? `${mediaDesc} ${result}` : mediaDesc
	}
	return result
}

describe("media description", () => {
	test("photo without name", () => {
		expect(buildMediaDescription({ type: "photo" })).toBe("[photo]")
	})

	test("document with filename", () => {
		expect(buildMediaDescription({ type: "document", fileName: "report.pdf" })).toBe(
			"[document: report.pdf]",
		)
	})

	test("voice with duration", () => {
		expect(buildMediaDescription({ type: "voice", duration: 15 })).toBe("[voice, 15s]")
	})

	test("video with filename and duration", () => {
		expect(buildMediaDescription({ type: "video", fileName: "clip.mp4", duration: 30 })).toBe(
			"[video: clip.mp4, 30s]",
		)
	})
})

describe("inbound text building", () => {
	test("plain text only", () => {
		expect(buildInboundText("hello")).toBe("hello")
	})

	test("text with reply context", () => {
		expect(buildInboundText("yes", "how are you?")).toBe('[Replying to: "how are you?"]\nyes')
	})

	test("media only (no text)", () => {
		expect(buildInboundText("", undefined, { type: "photo" })).toBe("[photo]")
	})

	test("media with text", () => {
		expect(buildInboundText("check this out", undefined, { type: "photo" })).toBe(
			"[photo] check this out",
		)
	})

	test("reply context + media + text", () => {
		const result = buildInboundText("here it is", "send the file", {
			type: "document",
			fileName: "data.csv",
		})
		expect(result).toBe('[document: data.csv] [Replying to: "send the file"]\nhere it is')
	})

	test("voice message with duration, no text", () => {
		expect(buildInboundText("", undefined, { type: "voice", duration: 8 })).toBe("[voice, 8s]")
	})
})

describe("detectMarkdown", () => {
	test("plain text — no markdown", () => {
		expect(detectMarkdown("hello world")).toBeUndefined()
	})

	test("text with special chars but no formatting", () => {
		expect(detectMarkdown("price is $10 (20% off)")).toBeUndefined()
	})

	test("single asterisk — not formatting", () => {
		expect(detectMarkdown("5 * 3 = 15")).toBeUndefined()
	})

	test("bold *text*", () => {
		expect(detectMarkdown("this is *bold*")).toBe("md2")
	})

	test("italic _text_", () => {
		expect(detectMarkdown("this is _italic_")).toBe("md2")
	})

	test("code `block`", () => {
		expect(detectMarkdown("run `npm install`")).toBe("md2")
	})

	test("strikethrough ~text~", () => {
		expect(detectMarkdown("this is ~wrong~")).toBe("md2")
	})

	test("spoiler ||text||", () => {
		expect(detectMarkdown("the answer is ||42||")).toBe("md2")
	})

	test("mixed formatting", () => {
		expect(detectMarkdown("*bold* and `code`")).toBe("md2")
	})
})
