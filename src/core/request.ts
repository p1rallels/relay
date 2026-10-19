/**
 * The human's `/relay`, from the command to its reset. It never cuts a run off: sent while the agent
 * works, it waits for the run's end, then the agent is asked for its handoff note and the context
 * resets at the end of the turn that answers. The adapter keeps it in its closure: it only matters
 * while the run it came in goes on.
 *
 * - `after-run`: sent while the agent worked; the ask waits for the run's last boundary
 * - `ask-sent`: the ask is on its way into the context (a run it starts, or a queue)
 * - `answering`: the ask is in the context; the turn that answers it ends with the reset
 */
export type HumanRequest = "after-run" | "ask-sent" | "answering";

export type TurnOutcome = "completed" | "error" | "aborted";

export interface CommandStep {
	readonly request: HumanRequest;
	/** ask: send the ask now · wait: for the run's end · duplicate: a request is already on, nothing more. */
	readonly action: "ask" | "wait" | "duplicate";
}

/**
 * A bare `/relay`. Two while the agent works are one request. Idle, it asks right away: a request still
 * recorded then is stale, since a live one keeps the session busy until its reset.
 */
export const commandStep = (request: HumanRequest | undefined, busy: boolean): CommandStep => {
	if (!busy) return { request: "ask-sent", action: "ask" };
	if (request !== undefined) return { request, action: "duplicate" };
	return { request: "after-run", action: "wait" };
};

/** The ask reached the context (its message_end): the next turn answers it. */
export const askDelivered = (request: HumanRequest | undefined): HumanRequest | undefined => (request === "ask-sent" ? "answering" : request);

export interface BeforeSettleStep {
	readonly request: HumanRequest | undefined;
	/** Append the ask and continue: the run's next turn answers it. */
	readonly ask: boolean;
}

/**
 * At the run's last boundary (agent_before_settle): a request that waited for the run gets its ask
 * now, straight into the context, and only once. It comes before the loop's prompt, so a keep-going
 * loop, which never lets a run settle, can't hold a /relay off.
 */
export const beforeSettleStep = (request: HumanRequest | undefined): BeforeSettleStep =>
	request === "after-run" ? { request: "answering", ask: true } : { request, ask: false };

export type TurnStep =
	| { readonly reset: false; readonly request: HumanRequest | undefined }
	| {
			readonly reset: true;
			readonly note: string;
			readonly byUser: boolean;
			/** The agent reset on its own before the ask reached it: that reset is the human's too. */
			readonly covered: boolean;
	  };

/**
 * At a turn's end: the agent's own relay call resets, and takes care of any request the human has on;
 * otherwise the turn that answered the ask resets once it completed (a failed one leaves it to pi's
 * retry). An aborted turn resets nothing; agent_settled drops the request.
 */
export const turnStep = (request: HumanRequest | undefined, agentNote: string | undefined, outcome: TurnOutcome): TurnStep => {
	if (outcome === "aborted") return { reset: false, request };
	if (agentNote !== undefined) {
		return { reset: true, note: agentNote, byUser: request !== undefined, covered: request === "after-run" || request === "ask-sent" };
	}
	if (request === "answering" && outcome === "completed") return { reset: true, note: "", byUser: true, covered: false };
	return { reset: false, request };
};

export interface SettledStep {
	readonly request: HumanRequest | undefined;
	/** ask: the boundary didn't, so start a turn for it · aborted / failed: the request is dropped, say why. */
	readonly action: "none" | "ask" | "aborted" | "failed";
}

/** When the run has settled: an abort drops the request; so does an ask whose turn never completed. */
export const settledStep = (request: HumanRequest | undefined, aborted: boolean): SettledStep => {
	if (request === undefined) return { request, action: "none" };
	if (aborted) return { request: undefined, action: "aborted" };
	switch (request) {
		case "after-run":
			return { request: "ask-sent", action: "ask" };
		case "answering":
			return { request: undefined, action: "failed" };
		case "ask-sent":
			return { request, action: "none" };
	}
};
