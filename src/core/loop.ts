import type { RelayConfig } from "./config.ts";
import type { LoopState, RelayState } from "./state.ts";

export const MAX_ERRORS = 3;
export const MAX_IDLE = 3;
/** Wait before continuing after the 1st and 2nd error outcome in a row; the 3rd stops the loop. */
export const BACKOFF_MS: readonly number[] = [5_000, 15_000];

export type Outcome = "completed" | "aborted" | "error";

export type SettleDecision =
	| { readonly action: "none" }
	| { readonly action: "continue"; readonly errors: number; readonly idle: number; readonly backoffMs: number }
	| { readonly action: "stop"; readonly reason: "errors" | "stalled" };

const NONE: SettleDecision = { action: "none" };

export const backoffMs = (errors: number): number => (errors <= 0 ? 0 : (BACKOFF_MS[Math.min(errors, BACKOFF_MS.length) - 1] ?? 0));

/**
 * What the loop does when the agent is about to settle. It only ever continues while it is on and
 * the run was not aborted, and every continuation is counted, so it cannot spin forever on errors
 * or on an agent that keeps answering without doing anything.
 */
export const settleDecision = (loop: LoopState, outcome: Outcome): SettleDecision => {
	if (!loop.on || outcome === "aborted") return NONE;
	if (outcome === "error") {
		const errors = loop.errors + 1;
		if (errors >= MAX_ERRORS) return { action: "stop", reason: "errors" };
		return { action: "continue", errors, idle: loop.idle, backoffMs: backoffMs(errors) };
	}
	const idle = loop.progressed ? 0 : loop.idle + 1;
	if (idle >= MAX_IDLE) return { action: "stop", reason: "stalled" };
	return { action: "continue", errors: 0, idle, backoffMs: 0 };
};

export type ToolDecision =
	| { readonly outcome: "duplicate" }
	| { readonly outcome: "done"; readonly loopWasOn: boolean }
	| { readonly outcome: "capped"; readonly max: number }
	| { readonly outcome: "queued"; readonly n: number };

/** What one relay tool call does. At most one reset per turn: later calls in the same turn do nothing. */
export const toolDecision = (done: boolean, alreadyQueued: boolean, state: RelayState, config: RelayConfig): ToolDecision => {
	if (alreadyQueued) return { outcome: "duplicate" };
	if (done) return { outcome: "done", loopWasOn: state.loop.on };
	if (config.maxResets !== undefined && state.resets >= config.maxResets) return { outcome: "capped", max: config.maxResets };
	return { outcome: "queued", n: state.resets + 1 };
};

/**
 * Whether a launch goal (PI_RELAY_GOAL / --relay-goal) should switch the loop on at session start:
 * yes on a fresh branch or for a new goal; a resume with the same goal keeps what the branch says,
 * so a loop that finished or was stopped stays stopped.
 */
export const launchGoalApplies = (goal: string | undefined, state: RelayState): goal is string => {
	if (goal === undefined) return false;
	if (!state.loopRecorded) return true;
	return state.loop.goal !== goal;
};
