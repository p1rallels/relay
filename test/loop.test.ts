import { describe, expect, test } from "bun:test";
import type { RelayConfig } from "../src/core/config.ts";
import { BACKOFF_MS, backoffMs, launchGoalApplies, loopDecides, MAX_ERRORS, MAX_IDLE, settleDecision, toolDecision } from "../src/core/loop.ts";
import { INITIAL_STATE, type LoopState, type RelayState } from "../src/core/state.ts";

const loop = (patch: Partial<LoopState>): LoopState => ({ ...INITIAL_STATE.loop, on: true, goal: "g", ...patch });
const config: RelayConfig = { nudgeAt: 40, nudgeEvery: 5, maxResets: undefined, goal: undefined };

describe("settleDecision", () => {
	test("off or aborted: never continues", () => {
		expect(settleDecision(INITIAL_STATE.loop, "completed")).toEqual({ action: "none" });
		expect(settleDecision(loop({}), "aborted")).toEqual({ action: "none" });
	});
	test("on and working: continues with clean counters", () => {
		expect(settleDecision(loop({ progressed: true, idle: 2 }), "completed")).toEqual({ action: "continue", errors: 0, idle: 0, backoffMs: 0 });
	});
	test("error runs wait 1m, 5m, then 15m, and the 4th in a row stops the loop", () => {
		expect(MAX_ERRORS).toBe(4);
		expect(BACKOFF_MS).toEqual([60_000, 300_000, 900_000]);
		expect(settleDecision(loop({ errors: 0 }), "error")).toEqual({ action: "continue", errors: 1, idle: 0, backoffMs: 60_000 });
		expect(settleDecision(loop({ errors: 1 }), "error")).toEqual({ action: "continue", errors: 2, idle: 0, backoffMs: 300_000 });
		expect(settleDecision(loop({ errors: 2 }), "error")).toEqual({ action: "continue", errors: 3, idle: 0, backoffMs: 900_000 });
		expect(settleDecision(loop({ errors: 3 }), "error")).toEqual({ action: "stop", reason: "errors" });
	});
	test("the error runs' idle count carries over; a good run clears the errors", () => {
		expect(settleDecision(loop({ errors: 1, idle: 2 }), "error")).toEqual({ action: "continue", errors: 2, idle: 2, backoffMs: 300_000 });
		expect(settleDecision(loop({ errors: 2, progressed: true }), "completed")).toEqual({ action: "continue", errors: 0, idle: 0, backoffMs: 0 });
	});
	test("an agent that keeps answering without a tool call stalls the loop", () => {
		expect(settleDecision(loop({ progressed: false, idle: 0 }), "completed")).toEqual({ action: "continue", errors: 0, idle: 1, backoffMs: 0 });
		expect(settleDecision(loop({ progressed: false, idle: MAX_IDLE - 1 }), "completed")).toEqual({ action: "stop", reason: "stalled" });
	});
	test("backoff is bounded", () => {
		expect(backoffMs(0)).toBe(0);
		expect(backoffMs(-1)).toBe(0);
		expect(backoffMs(99)).toBe(BACKOFF_MS[BACKOFF_MS.length - 1] ?? -1);
	});
});

describe("settleDecision with live subs", () => {
	test("a live sub holds the loop: no prompt, and neither a stall nor an error is counted", () => {
		expect(settleDecision(loop({ progressed: false, idle: MAX_IDLE - 1 }), "completed", true)).toEqual({ action: "wait" });
		expect(settleDecision(loop({ progressed: true }), "completed", true)).toEqual({ action: "wait" });
		expect(settleDecision(loop({ errors: MAX_ERRORS - 1 }), "error", true)).toEqual({ action: "wait" });
	});
	test("once no sub is live, the counts pick up where they were", () => {
		expect(settleDecision(loop({ progressed: false, idle: MAX_IDLE - 1 }), "completed", false)).toEqual({ action: "stop", reason: "stalled" });
		expect(settleDecision(loop({ progressed: false, idle: 1 }), "completed", false)).toEqual({ action: "continue", errors: 0, idle: 2, backoffMs: 0 });
	});
	test("off or aborted, subs don't matter", () => {
		expect(settleDecision(INITIAL_STATE.loop, "completed", true)).toEqual({ action: "none" });
		expect(settleDecision(loop({}), "aborted", true)).toEqual({ action: "none" });
	});
	test("subs are only worth a look when the loop is on and the run wasn't aborted", () => {
		expect(loopDecides(loop({}), "completed")).toBe(true);
		expect(loopDecides(loop({}), "error")).toBe(true);
		expect(loopDecides(loop({}), "aborted")).toBe(false);
		expect(loopDecides(INITIAL_STATE.loop, "completed")).toBe(false);
	});
});

describe("toolDecision", () => {
	const state = (patch: Partial<RelayState>): RelayState => ({ ...INITIAL_STATE, ...patch });
	test("queues reset n+1", () => {
		expect(toolDecision(false, false, state({ resets: 2 }), config)).toEqual({ outcome: "queued", n: 3 });
	});
	test("a second call in the same turn is a no-op", () => {
		expect(toolDecision(false, true, state({}), config)).toEqual({ outcome: "duplicate" });
		expect(toolDecision(true, true, state({}), config)).toEqual({ outcome: "duplicate" });
	});
	test("done ends the loop instead of resetting", () => {
		expect(toolDecision(true, false, state({ loop: loop({}) }), config)).toEqual({ outcome: "done", loopWasOn: true });
		expect(toolDecision(true, false, state({}), config)).toEqual({ outcome: "done", loopWasOn: false });
	});
	test("the cap refuses further resets", () => {
		expect(toolDecision(false, false, state({ resets: 2 }), { ...config, maxResets: 2 })).toEqual({ outcome: "capped", max: 2 });
		expect(toolDecision(false, false, state({ resets: 0 }), { ...config, maxResets: 0 })).toEqual({ outcome: "capped", max: 0 });
		expect(toolDecision(false, false, state({ resets: 1 }), { ...config, maxResets: 2 })).toEqual({ outcome: "queued", n: 2 });
	});
});

describe("launchGoalApplies", () => {
	test("fresh branch: yes; no goal: no", () => {
		expect(launchGoalApplies("g", INITIAL_STATE)).toBe(true);
		expect(launchGoalApplies(undefined, INITIAL_STATE)).toBe(false);
	});
	test("a resume with the same goal keeps what the branch says", () => {
		const finished: RelayState = { ...INITIAL_STATE, loopRecorded: true, loop: { ...INITIAL_STATE.loop, goal: "g", stopped: "done" } };
		expect(launchGoalApplies("g", finished)).toBe(false);
		expect(launchGoalApplies("a new goal", finished)).toBe(true);
	});
});
