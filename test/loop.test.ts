import { describe, expect, test } from "bun:test";
import type { RelayConfig } from "../src/core/config.ts";
import { BACKOFF_MS, backoffMs, launchGoalApplies, MAX_ERRORS, MAX_IDLE, settleDecision, toolDecision } from "../src/core/loop.ts";
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
	test("errors back off, then stop at the third in a row", () => {
		expect(settleDecision(loop({ errors: 0 }), "error")).toEqual({ action: "continue", errors: 1, idle: 0, backoffMs: BACKOFF_MS[0] ?? -1 });
		expect(settleDecision(loop({ errors: 1 }), "error")).toEqual({ action: "continue", errors: 2, idle: 0, backoffMs: BACKOFF_MS[1] ?? -1 });
		expect(settleDecision(loop({ errors: MAX_ERRORS - 1 }), "error")).toEqual({ action: "stop", reason: "errors" });
	});
	test("an agent that keeps answering without a tool call stalls the loop", () => {
		expect(settleDecision(loop({ progressed: false, idle: 0 }), "completed")).toEqual({ action: "continue", errors: 0, idle: 1, backoffMs: 0 });
		expect(settleDecision(loop({ progressed: false, idle: MAX_IDLE - 1 }), "completed")).toEqual({ action: "stop", reason: "stalled" });
	});
	test("backoff is bounded", () => {
		expect(backoffMs(0)).toBe(0);
		expect(backoffMs(99)).toBe(BACKOFF_MS[BACKOFF_MS.length - 1] ?? -1);
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
