import type { Entry } from "../src/core/entries.ts";

let counter = 0;
const nextId = (): string => `e${(++counter).toString(16).padStart(7, "0")}`;
const stamp = (minute: number): string => `2026-10-19T06:${String(minute % 60).padStart(2, "0")}:00.000Z`;

export const user = (text: string, minute = 0): Entry => ({
	type: "message",
	id: nextId(),
	timestamp: stamp(minute),
	message: { role: "user", content: [{ type: "text", text }] },
});

export const assistant = (opts: { tools?: number; stopReason?: string } = {}): Entry => ({
	type: "message",
	id: nextId(),
	timestamp: stamp(1),
	message: {
		role: "assistant",
		stopReason: opts.stopReason ?? (opts.tools ? "toolUse" : "stop"),
		content: [
			{ type: "text", text: "ok" },
			...Array.from({ length: opts.tools ?? 0 }, (_, index) => ({ type: "toolCall", id: `t${index}`, name: "bash", arguments: {} })),
		],
	},
});

export const relayMsg = (details: Record<string, unknown>): Entry => ({ type: "custom_message", id: nextId(), customType: "relay", details, message: undefined });

export const relaySwitch = (data: Record<string, unknown>): Entry => ({ type: "custom", id: nextId(), customType: "relay", data });

export const compaction = (relay?: Record<string, unknown>): Entry => ({ type: "compaction", id: nextId(), details: relay ? { relay } : undefined });

export const relayResult = (details: Record<string, unknown>): Entry => ({
	type: "message",
	id: nextId(),
	message: { role: "toolResult", toolName: "relay", content: [{ type: "text", text: "…" }], details },
});
