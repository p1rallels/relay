/**
 * What relay writes into a session, and readers for the session entries it cares about.
 * Entries are typed structurally so this file needs no pi import; every field is checked,
 * because a session file may hold entries from older versions or other extensions.
 */

export const CUSTOM_TYPE = "relay";
export const TOOL_NAME = "relay";

export type RelayKind = "nudge" | "reset" | "loop";

export type StopReason = "user" | "aborted" | "done" | "errors" | "stalled" | "cap";

/** `details` of a relay custom message (contract: kind, percent?, n?, note?, goal?; the rest are extras). */
export interface RelayDetails {
	readonly kind: RelayKind;
	readonly percent?: number;
	readonly n?: number;
	readonly note?: string;
	readonly goal?: string;
	/** nudge: the step it was sent for. */
	readonly step?: number;
	/** loop: consecutive error outcomes so far. */
	readonly errors?: number;
	/** loop: consecutive loop prompts answered without a tool call. */
	readonly idle?: number;
	/** loop: the loop ended here, and why. */
	readonly stopped?: StopReason;
	/** reset or nudge asked for by the human (/relay). */
	readonly byUser?: true;
}

/** `details.relay` of the compaction entry each reset writes. */
export interface CompactionRelay {
	readonly n: number;
	readonly percent?: number;
	readonly note?: string;
	readonly goal?: string;
}

/** `data` of a relay custom entry: the loop switched on or off. Invisible to the model. */
export type LoopSwitch =
	| { readonly loop: "on"; readonly goal?: string; readonly by: "user" | "launch" }
	| { readonly loop: "off"; readonly reason: StopReason };

/** `details` of a relay tool result. */
export interface ToolDetails {
	readonly outcome: "queued" | "duplicate" | "done" | "capped";
	readonly note?: string;
	readonly n?: number;
}

/** The fields relay reads; pi's SessionEntry types are assignable to it. */
export interface Entry {
	readonly type: string;
	readonly id?: string;
	readonly timestamp?: string;
	readonly customType?: string;
	readonly data?: unknown;
	readonly details?: unknown;
	readonly message?: unknown;
}

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const finite = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const KINDS: readonly string[] = ["nudge", "reset", "loop"];
const STOP_REASONS: readonly string[] = ["user", "aborted", "done", "errors", "stalled", "cap"];

const stopReason = (value: unknown): StopReason | undefined =>
	typeof value === "string" && STOP_REASONS.includes(value) ? (value as StopReason) : undefined;

export const relayMessage = (entry: Entry): RelayDetails | undefined => {
	if (entry.type !== "custom_message" || entry.customType !== CUSTOM_TYPE) return undefined;
	const details = record(entry.details);
	const kind = details?.kind;
	if (!details || typeof kind !== "string" || !KINDS.includes(kind)) return undefined;
	return {
		kind: kind as RelayKind,
		percent: finite(details.percent),
		n: finite(details.n),
		note: text(details.note),
		goal: text(details.goal),
		step: finite(details.step),
		errors: finite(details.errors),
		idle: finite(details.idle),
		stopped: stopReason(details.stopped),
		...(details.byUser === true ? { byUser: true as const } : {}),
	};
};

export const relayCompaction = (entry: Entry): CompactionRelay | undefined => {
	if (entry.type !== "compaction") return undefined;
	const relay = record(record(entry.details)?.relay);
	const n = finite(relay?.n);
	if (!relay || n === undefined) return undefined;
	return { n, percent: finite(relay.percent), note: text(relay.note), goal: text(relay.goal) };
};

export const loopSwitch = (entry: Entry): LoopSwitch | undefined => {
	if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) return undefined;
	const data = record(entry.data);
	if (data?.loop === "on") {
		const goal = text(data.goal);
		return { loop: "on", ...(goal ? { goal } : {}), by: data.by === "launch" ? "launch" : "user" };
	}
	if (data?.loop === "off") return { loop: "off", reason: stopReason(data.reason) ?? "user" };
	return undefined;
};

interface MessageView {
	readonly role?: unknown;
	readonly content?: unknown;
	readonly toolName?: unknown;
	readonly details?: unknown;
	readonly stopReason?: unknown;
	readonly usage?: unknown;
}

const messageOf = (entry: Entry): MessageView | undefined => (entry.type === "message" ? (record(entry.message) as MessageView | undefined) : undefined);

export const relayToolResult = (entry: Entry): ToolDetails | undefined => {
	const message = messageOf(entry);
	if (message?.role !== "toolResult" || message.toolName !== TOOL_NAME) return undefined;
	const details = record(message.details);
	const outcome = details?.outcome;
	if (outcome !== "queued" && outcome !== "duplicate" && outcome !== "done" && outcome !== "capped") return undefined;
	return { outcome, note: text(details?.note), n: finite(details?.n) };
};

const partsText = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const piece = record(part);
			if (piece?.type === "text") return text(piece.text) ?? "";
			if (piece?.type === "image") return "[image]";
			return "";
		})
		.filter((piece) => piece !== "")
		.join("\n");
};

export interface UserMessage {
	/** 1-based position among the session's user messages. */
	readonly index: number;
	readonly text: string;
	readonly timestamp: string | undefined;
}

/** What a human (or the spawning prompt) typed, oldest first. Custom messages (msg, relay) are not users. */
export const userMessages = (entries: readonly Entry[]): UserMessage[] =>
	entries
		.flatMap((entry) => {
			const message = messageOf(entry);
			if (message?.role !== "user") return [];
			return [{ text: partsText(message.content), timestamp: entry.timestamp }];
		})
		.map((message, position) => ({ index: position + 1, ...message }));

export interface AssistantView {
	readonly stopReason: string | undefined;
	readonly toolCalls: number;
	/** What the request behind it carried: input + cache read + cache write tokens. */
	readonly requestTokens: number;
}

const requestTokensOf = (usage: unknown): number => {
	const fields = record(usage);
	return ["input", "cacheRead", "cacheWrite"].reduce((sum, key) => sum + (finite(fields?.[key]) ?? 0), 0);
};

export const assistantMessage = (entry: Entry): AssistantView | undefined => {
	const message = messageOf(entry);
	if (message?.role !== "assistant") return undefined;
	const toolCalls = Array.isArray(message.content) ? message.content.filter((part) => record(part)?.type === "toolCall").length : 0;
	return { stopReason: text(message.stopReason), toolCalls, requestTokens: requestTokensOf(message.usage) };
};
