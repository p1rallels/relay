import { describe, expect, test } from "bun:test";
import { humanAskDraft, nudgeDraft } from "../src/core/drafts.ts";
import { isHandoffAsk } from "../src/core/entries.ts";
import { askDelivered, beforeSettleStep, commandStep, type HumanRequest, settledStep, turnStep } from "../src/core/request.ts";

const REQUESTS: readonly (HumanRequest | undefined)[] = [undefined, "after-run", "ask-sent", "answering"];

const asMessage = (draft: { customType: string; content: string; display: boolean; details: unknown }) => ({ role: "custom", ...draft, timestamp: 0 });

describe("a bare /relay", () => {
	test("busy: waits for the run instead of cutting it off", () => {
		expect(commandStep(undefined, true)).toEqual({ request: "after-run", action: "wait" });
	});
	test("busy: two /relay's are one request, whatever stage the first is at", () => {
		expect(commandStep("after-run", true)).toEqual({ request: "after-run", action: "duplicate" });
		expect(commandStep("ask-sent", true)).toEqual({ request: "ask-sent", action: "duplicate" });
		expect(commandStep("answering", true)).toEqual({ request: "answering", action: "duplicate" });
	});
	test("idle: asks right away, replacing anything stale", () => {
		for (const request of REQUESTS) expect(commandStep(request, false)).toEqual({ request: "ask-sent", action: "ask" });
	});
});

describe("the ask", () => {
	test("reaching the context means the next turn answers it", () => {
		expect(askDelivered("ask-sent")).toBe("answering");
		expect(askDelivered(undefined)).toBeUndefined();
		expect(askDelivered("answering")).toBe("answering");
		expect(askDelivered("after-run")).toBe("after-run");
	});
	test("is told apart from relay's other messages", () => {
		expect(isHandoffAsk(asMessage(humanAskDraft(47.2)))).toBe(true);
		expect(isHandoffAsk(asMessage(humanAskDraft(undefined)))).toBe(true);
		expect(isHandoffAsk(asMessage(nudgeDraft(47.2, 45, false)))).toBe(false);
		expect(isHandoffAsk({ ...asMessage(humanAskDraft(1)), customType: "msg" })).toBe(false);
		expect(isHandoffAsk({ role: "user", content: "[relay] the human asked for a context reset" })).toBe(false);
		expect(isHandoffAsk(undefined)).toBe(false);
	});
	test("a request that waited for the run gets its ask at the run's last boundary, once", () => {
		expect(beforeSettleStep("after-run")).toEqual({ request: "answering", ask: true });
		expect(beforeSettleStep("answering")).toEqual({ request: "answering", ask: false });
		expect(beforeSettleStep("ask-sent")).toEqual({ request: "ask-sent", ask: false });
		expect(beforeSettleStep(undefined)).toEqual({ request: undefined, ask: false });
	});
});

describe("at a turn's end", () => {
	test("the relay tool still resets at the end of the turn it was called in", () => {
		expect(turnStep(undefined, "NOTE", "completed")).toEqual({ reset: true, note: "NOTE", byUser: false, covered: false });
	});
	test("an agent reset while a /relay waits is the human's reset too, and nothing more happens", () => {
		expect(turnStep("after-run", "NOTE", "completed")).toEqual({ reset: true, note: "NOTE", byUser: true, covered: true });
		expect(turnStep("ask-sent", "NOTE", "completed")).toEqual({ reset: true, note: "NOTE", byUser: true, covered: true });
	});
	test("the turn that answers the ask resets, with the agent's note or without one", () => {
		expect(turnStep("answering", "NOTE", "completed")).toEqual({ reset: true, note: "NOTE", byUser: true, covered: false });
		expect(turnStep("answering", undefined, "completed")).toEqual({ reset: true, note: "", byUser: true, covered: false });
	});
	test("a waiting /relay never resets mid-run", () => {
		expect(turnStep("after-run", undefined, "completed")).toEqual({ reset: false, request: "after-run" });
		expect(turnStep("ask-sent", undefined, "completed")).toEqual({ reset: false, request: "ask-sent" });
	});
	test("a failed answer leaves the reset to pi's retry", () => {
		expect(turnStep("answering", undefined, "error")).toEqual({ reset: false, request: "answering" });
	});
	test("an aborted turn resets nothing", () => {
		for (const request of REQUESTS) {
			expect(turnStep(request, "NOTE", "aborted")).toEqual({ reset: false, request });
			expect(turnStep(request, undefined, "aborted")).toEqual({ reset: false, request });
		}
	});
	test("no request, no relay call: nothing", () => {
		expect(turnStep(undefined, undefined, "completed")).toEqual({ reset: false, request: undefined });
	});
});

describe("when the run has settled", () => {
	test("an abort drops the request, whatever stage it was at", () => {
		for (const request of REQUESTS.filter((item) => item !== undefined)) expect(settledStep(request, true)).toEqual({ request: undefined, action: "aborted" });
	});
	test("a request the last boundary didn't ask for gets a turn of its own", () => {
		expect(settledStep("after-run", false)).toEqual({ request: "ask-sent", action: "ask" });
	});
	test("an ask whose turn never completed is dropped as failed", () => {
		expect(settledStep("answering", false)).toEqual({ request: undefined, action: "failed" });
	});
	test("an ask still on its way stays; no request, nothing", () => {
		expect(settledStep("ask-sent", false)).toEqual({ request: "ask-sent", action: "none" });
		expect(settledStep(undefined, false)).toEqual({ request: undefined, action: "none" });
		expect(settledStep(undefined, true)).toEqual({ request: undefined, action: "none" });
	});
});
