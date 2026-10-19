import { assistantMessage, type Entry, loopSwitch, relayCompaction, relayMessage, relayToolResult, type StopReason } from "./entries.ts";

export interface LoopState {
	readonly on: boolean;
	/** The goal it was last switched on with; kept after it stops. Undefined: the session's first user message. */
	readonly goal: string | undefined;
	/** Why it is off, when it ran before. */
	readonly stopped: StopReason | undefined;
	/** Consecutive error outcomes at settle. */
	readonly errors: number;
	/** Consecutive loop prompts the agent answered without calling a tool. */
	readonly idle: number;
	/** Whether the agent called a tool since the last loop prompt (true before the first one). */
	readonly progressed: boolean;
}

export interface RelayState {
	/** Resets done in this session (relay compactions on the branch). */
	readonly resets: number;
	/** The last step nudged since the context last shrank (any compaction starts the steps over). */
	readonly lastNudgeStep: number | undefined;
	/** Whether anything ever switched the loop on or off on this branch. */
	readonly loopRecorded: boolean;
	readonly loop: LoopState;
}

export const INITIAL_STATE: RelayState = {
	resets: 0,
	lastNudgeStep: undefined,
	loopRecorded: false,
	loop: { on: false, goal: undefined, stopped: undefined, errors: 0, idle: 0, progressed: true },
};

const stop = (state: RelayState, reason: StopReason): RelayState =>
	state.loop.on ? { ...state, loopRecorded: true, loop: { ...state.loop, on: false, stopped: reason } } : state;

/** One entry's effect on the relay state. */
export const reduce = (state: RelayState, entry: Entry): RelayState => {
	if (entry.type === "compaction") {
		const relay = relayCompaction(entry);
		const resets = relay ? Math.max(state.resets + 1, relay.n) : state.resets;
		return { ...state, resets, lastNudgeStep: undefined };
	}
	const switched = loopSwitch(entry);
	if (switched?.loop === "on") {
		return {
			...state,
			loopRecorded: true,
			loop: { on: true, goal: switched.goal ?? state.loop.goal, stopped: undefined, errors: 0, idle: 0, progressed: true },
		};
	}
	if (switched?.loop === "off") return { ...stop(state, switched.reason), loopRecorded: true };
	const message = relayMessage(entry);
	if (message?.kind === "nudge" && !message.byUser) return { ...state, lastNudgeStep: message.step ?? message.percent ?? state.lastNudgeStep };
	if (message?.kind === "loop" && message.stopped === undefined) {
		return { ...state, loop: { ...state.loop, errors: message.errors ?? 0, idle: message.idle ?? 0, progressed: false } };
	}
	const tool = relayToolResult(entry);
	if (tool?.outcome === "done") return stop(state, "done");
	if (tool?.outcome === "capped") return stop(state, "cap");
	const assistant = assistantMessage(entry);
	if (!assistant) return state;
	const failed = assistant.stopReason === "error" || assistant.stopReason === "aborted";
	const errors = failed ? state.loop.errors : 0;
	const progressed = state.loop.progressed || assistant.toolCalls > 0;
	return { ...state, loop: { ...state.loop, errors, progressed, idle: assistant.toolCalls > 0 ? 0 : state.loop.idle } };
};

/** Relay state rebuilt from a branch (root to leaf), so a resume or a re-attach picks up where it was. */
export const stateFrom = (entries: readonly Entry[]): RelayState => entries.reduce(reduce, INITIAL_STATE);
